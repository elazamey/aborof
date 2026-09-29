import { test, describe } from "node:test";
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
  connectionUrlFromClaims,
  dashboardUrlToConnectionCandidates,
  decodeTokenClaims,
  describeDatabaseUrl,
  formatTimespan,
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

  test("سبب 401 الخام يُترجم إلى أربعة علاجات مختلفة — وأمتنعها مكتوبًا كأكواد ثابتة", () => {
    // سبب الخادم هو الفارق بين: جدد الرمز · رمز قاعدة أخرى · القيمة لم تصل.
    const expired = interpretProbeStatus(401, '{"error":"JWT error: token is expired by 100 seconds"}');
    assert.equal(expired.code, "TURSO_TOKEN_EXPIRED");
    assert.match(expired.verdict, /الرمز مرفوض/);
    assert.match(expired.verdict, /منتهي الصلاحية/);
    assert.match(expired.verdict, /apply-turso-secrets/);

    const empty = interpretProbeStatus(401, "unauthorized access attempt on database: empty JWT token");
    assert.equal(empty.code, "TURSO_AUTH_401_EMPTY_JWT");
    assert.match(empty.verdict, /لم يصل للخادم/);

    const signature = interpretProbeStatus(401, '{"error":"JWT error: signature verification failed"}');
    assert.equal(signature.code, "TURSO_TOKEN_SIGNATURE");
    assert.match(signature.verdict, /بصمة/);

    const generic = interpretProbeStatus(401, '{"error":"custom reason"}');
    assert.equal(generic.code, "TURSO_AUTH_401");
    assert.match(generic.verdict, /سبب الخادم: \{"error":"custom reason"\}/);

    // بلا جسم: النسخة العامة كما قبل — اختبارات الترجمة أعلاه تبقى صامدة.
    assert.equal(interpretProbeStatus(401).code, "TURSO_AUTH_401");
    assert.equal(interpretProbeStatus(403).code, "TURSO_FORBIDDEN");
    assert.equal(interpretProbeStatus(404).code, "TURSO_DB_NOT_FOUND");
  });

  test("فكّ ادعاءات الرمز: الصلاحية والادّعاءات فقط — بلا أي جزء من القيمة", () => {
    const sign = "MEUCIQDx-fake-signature-for-tests-abcdefgh";
    const jwt = (payload: object, header = { alg: "ES256", typ: "JWT" }) =>
      `${Buffer.from(JSON.stringify(header)).toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${sign}`;

    const future = decodeTokenClaims(jwt({ exp: 1893456000, iat: 1790000000, db: "unit-test", org: "example" }));
    assert.equal(future.ok, true);
    assert.equal(future.alg, "ES256");
    assert.equal(future.db, "unit-test");
    assert.equal(future.org, "example");
    assert.equal(future.expired, false);
    assert.ok(typeof future.secondsLeft === "number" && future.secondsLeft > 0);
    // لا شيء من مقطع التوقيع (ولا من أي مقطع) يعود في المخرجات:
    assert.ok(!JSON.stringify(future).includes(sign));

    const past = decodeTokenClaims(jwt({ exp: 1700000000, db: "rofyd", org: "elazamey" }));
    assert.equal(past.ok, true);
    assert.equal(past.expired, true);
    assert.ok((past.secondsLeft ?? 0) < 0);

    const timeless = decodeTokenClaims(jwt({ db: "rofyd", org: "elazamey" }));
    assert.equal(timeless.expired, null, "غياب exp = صلاحية غير محددة لا انتهاء");

    assert.equal(decodeTokenClaims("eyJhbGciOiJIUzI1NiJ9.a.b").ok, false, "مقطع ادّعاءات تالف يُرفض");
    assert.equal(decodeTokenClaims("").ok, false);
    assert.equal(decodeTokenClaims("libsql://x.turso.io").ok, false);
  });

  test("اشتقاق الرابط من الادّعاءات بنفس قواعد اشتقاق اللوحة — وترطيب سليم", () => {
    assert.deepEqual(connectionUrlFromClaims({ db: "unit-test", org: "example" }), [
      "libsql://unit-test-example.turso.io",
      "libsql://example-unit-test.turso.io",
    ]);
    assert.deepEqual(connectionUrlFromClaims({ db: "Store", org: "store" }), ["libsql://store-store.turso.io"]);
    assert.deepEqual(connectionUrlFromClaims({ db: null, org: "example" }), []);
    assert.deepEqual(connectionUrlFromClaims(null), []);
    // تنقية slug: ما لا يُصلح للمضيف لا يدخل المرشّحات أصلًا.
    assert.deepEqual(connectionUrlFromClaims({ db: "../etc", org: "example" }), [
      "libsql://etc-example.turso.io",
      "libsql://example-etc.turso.io",
    ]);
  });

  test("وصف المدة الزمنية عربي بلا قيم خام", () => {
    assert.equal(formatTimespan(30), "30 ثانية");
    assert.equal(formatTimespan(-4000), "1 ساعة");
    assert.equal(formatTimespan(86400 * 3), "3 يوم");
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
    // صفّا التشخيص الجديدان: ادعاءات الرمز (فكّ المقطع الثاني) والسبب الخام
    // الموثّق بالرمز — كلاهما يظهران بلا أي جزء من القيمة، ويُختم الحكم صراحةً.
    assert.match(res.stdout, /conn-token-claims/);
    assert.match(res.stdout, /conn-cause/);
    assert.match(res.stdout, /FINAL: BLOCKED/);
    assert.doesNotMatch(res.stdout + res.stderr, /is not defined/);
    assert.doesNotMatch(res.stdout, /example-db-example/, "لا يُطبع الرابط ولا الرمز");
  });

  test("رمز سليم الشكل على قاعدة بعيدة: الادّعاءات تُقرأ والحكم يُختَم BLOCKED — بلا تسريب", () => {
    // نفس بنية الإنتاج الحالية (JWT صالح الشكل في حقل الرمز) — الاتصال يفشل
    // بلا شبكة/بلا قاعدة، لكن صف conn-token-claims يجب أن يقرأ الادّعاءات
    // ويفصل «صالح زمنيًا» عن «انتهى»، ويُصدر FINAL: BLOCKED آليًا.
    const header = Buffer.from(JSON.stringify({ alg: "ES256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ exp: 1893456000, iat: 1790000000, db: "unit-test", org: "example" })
    ).toString("base64url");
    const sign = "MEUCIQDx-fake-signature-for-tests-abcdefgh";
    const token = `${header}.${payload}.${sign}`;
    const env = {
      ...process.env,
      TURSO_DATABASE_URL: "libsql://unit-test-example.turso.io",
      TURSO_AUTH_TOKEN: token,
    };
    const res = spawnSync("node", ["scripts/verify-turso.mjs", "--allow-secret-repair"], { encoding: "utf8", env });
    assert.equal(res.status, 1);
    assert.match(res.stdout, /conn-token-claims/);
    assert.match(res.stdout, /صالح — ينتهي خلال/, "الادّعاءات تُقرأ كصلاحية زمنية");
    assert.match(res.stdout, /FINAL: BLOCKED/);
    assert.doesNotMatch(res.stdout + res.stderr, new RegExp(sign), "لا يُطبع التوقيع");
    assert.doesNotMatch(res.stdout, new RegExp(payload), "لا يُطبع مقطع الادّعاءات");
    assert.doesNotMatch(res.stdout, /unit-test-example/, "لا يُطبع المضيف كاملًا");
  });

  test("JWT بلا ادّعاءي db/org (بنية الإنتاج الحالية: alg EdDSA) يُحاكم «ليس توكن قاعدة»", () => {
    // الحالة الحيّة الموثّقة في تعليق PR: رمز EdDSA بلا exp/db/org والخادم
    // يرد «invalid JWT token» — الصف يجب أن يسقطه بـ TURSO_TOKEN_NO_DB_CLAIMS
    // لا أن يتركه ✅ مُطمئنًا، ويُختم BLOCKED.
    const header = Buffer.from(JSON.stringify({ alg: "EdDSA" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ sub: "not-a-turso-db-token" })).toString("base64url");
    const token = `${header}.${payload}.c2lnbmF0dXJl`;
    const env = {
      ...process.env,
      TURSO_DATABASE_URL: "libsql://rof-example.turso.io",
      TURSO_AUTH_TOKEN: token,
    };
    const res = spawnSync("node", ["scripts/verify-turso.mjs", "--allow-secret-repair"], { encoding: "utf8", env });
    assert.equal(res.status, 1);
    assert.match(res.stdout, /TURSO_TOKEN_NO_DB_CLAIMS/);
    assert.match(res.stdout, /ليس بصيغة توكن قاعدة Turso/);
    assert.match(res.stdout, /FINAL: BLOCKED/);
    assert.doesNotMatch(res.stdout + res.stderr, /not-a-turso-db-token/, "لا يُطبع ادعاء");
    assert.doesNotMatch(res.stdout, /rof-example/, "لا يُطبع المضيف كاملًا");
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

  test("فصل الأسمية: الأدوار _PROD/_CI تظهر كخطوات صريحة ولا تُطبع قيمها", () => {
    // vercel CLI غير مثبّت في بيئة الاختبار — وهمي على PATH كي تُبنى خطواته.
    const binDir = fs.mkdtempSync(path.join(tmpdir(), "role-fake-bin-"));
    const stub = path.join(binDir, "vercel");
    fs.writeFileSync(stub, "#!/usr/bin/env bash\nexit 0\n");
    fs.chmodSync(stub, 0o755);
    try {
      const res = run(
        {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          TURSO_DATABASE_URL: GOOD_URL,
          TURSO_AUTH_TOKEN: GOOD_TOKEN,
          TURSO_AUTH_TOKEN_CI: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjaS10b2tlbiJ9.c2lnY2k",
          TURSO_AUTH_TOKEN_PROD: GOOD_TOKEN,
        },
        ["--dry-run", "--skip-verify"]
      );
      assert.equal(res.status, 0, res.stdout + res.stderr);
      assert.match(res.stdout, /gh secret set TURSO_AUTH_TOKEN_CI --env production/);
      assert.match(res.stdout, /دور CI القصير المدى/);
      assert.match(res.stdout, /vercel env add TURSO_AUTH_TOKEN_PROD production/);
      assert.match(res.stdout, /دور PROD الكامل/);
      // القيم لا تظهر أبدًا (فقط الأسماء والأدوار وأطوال الشكل).
      assert.doesNotMatch(res.stdout + res.stderr, /c2lnY2k/);
      assert.doesNotMatch(res.stdout + res.stderr, new RegExp(GOOD_TOKEN));
      assert.doesNotMatch(res.stdout, /aborof-elazamey/, "لا يُطبع المضيف كاملًا");
    } finally {
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });
});

describe("scripts/mint-turso-token.sh — تحويل توكن المنصّة إلى زوج قاعدة", () => {
  // نفس عقد api() في السكربت: الجسم في سطر (أو أكثر) ثم سطر رمز الحالة.
  const MINTED_JWT = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJtaW50ZWQifQ.c2lnbmF0dXJl";
  // توكن بادّعاء db مخالف — يثبت فشل الهوية المغلق قبل أي كتابة.
  const b64u = (s: string) => Buffer.from(s, "utf8").toString("base64url");
  const MISMATCH_JWT = `eyJhbGciOiJFZERTQSJ9.${b64u('{"db":"otherdb"}')}.c2ln`;
  const PASS_JWT = `eyJhbGciOiJFZERTQSJ9.${b64u('{"db":"rofyd","org":"elazamey"}')}.c2ln`;
  const NOCLAIMS_JWT = `eyJhbGciOiJFZERTQSJ9.${b64u('{"exp":9999999999}')}.c2ln`;

  function makeFakes() {
    const binDir = fs.mkdtempSync(path.join(tmpdir(), "mint-fake-bin-"));
    const logFile = path.join(binDir, "calls.log");
    // curl وهمي يرد بردود المنصّة المصنوعة حسب المسار (لا شبكة في الاختبار)؛
    // FAKE_JWT يسمح بإرجاع توكن بادّعاءات مختلفة لاختبار بوابة الهوية.
    const curl = [
      "#!/usr/bin/env bash",
      `echo "CURL $*" >> "${logFile}"`,
      'url=""',
      'for a in "$@"; do case "$a" in https://*) url="$a" ;; esac; done',
      'case "$url" in',
      `  */auth/tokens*) printf '%s\\n%s' "{\\"jwt\\":\\"\${FAKE_JWT:-${MINTED_JWT}}\\"}" 200 ;;`,
      // مؤسسة بلا قواعد (مسح تعدد المؤسسات) قبل القالب العام.
      `  */organizations/acme/databases) printf '%s\\n%s' '{"databases":[]}' 200 ;;`,
      `  */databases) dbs="$FAKE_DBS"; [ -z "$dbs" ] && dbs='{"databases":[{"Name":"rofyd","Hostname":"rofyd-elazamey.turso.io"}]}'; printf '%s\\n%s' "$dbs" 200 ;;`,
      // عقد المنصّة الحقيقي: مصفوفة سادة [{slug,…}] — FAKE_ORGS لسيناريو التعدد.
      `  */v1/organizations) orgs="$FAKE_ORGS"; [ -z "$orgs" ] && orgs='[{"slug":"elazamey"}]'; printf '%s\\n%s' "$orgs" 200 ;;`,
      `  *) printf '%s\\n%s' '{}' 404 ;;`,
      "esac",
      "",
    ].join("\n");
    // gh/vercel وهميان يستهلكان stdin (apply تمرّر القيم عبر stdin) ثم يسجّلان.
    const consumer = ["#!/usr/bin/env bash", "cat > /dev/null", `echo "$0 $*" >> "${logFile}"`, ""].join("\n");
    for (const [name, body] of [
      ["curl", curl],
      ["gh", consumer],
      ["vercel", consumer],
    ] as const) {
      const p = path.join(binDir, name);
      fs.writeFileSync(p, body);
      fs.chmodSync(p, 0o755);
    }
    return { binDir, logFile };
  }

  test("بدون TURSO_PLATFORM_TOKEN يسقط فورًا برسالة تحدّد المتغير — بلا أي نداء شبكة", () => {
    const { binDir, logFile } = makeFakes();
    try {
      const res = spawnSync("bash", ["scripts/mint-turso-token.sh"], {
        encoding: "utf8",
        input: "",
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, TURSO_PLATFORM_TOKEN: "", TURSO_API_TOKEN: "" },
      });
      assert.equal(res.status, 1);
      assert.match(res.stderr, /TURSO_PLATFORM_TOKEN/);
      assert.equal(fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "", "", "لا نداء curl قبل التحقق من التوكن");
    } finally {
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });

  test("المسار الجاف (--dry-run --skip-verify): يسكّ من المنصّة ولا يكتب شيئًا ولا يطبع قيمة", () => {
    const { binDir, logFile } = makeFakes();
    try {
      const res = spawnSync("bash", ["scripts/mint-turso-token.sh", "--dry-run", "--skip-verify"], {
        encoding: "utf8",
        input: "",
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          TURSO_PLATFORM_TOKEN: "platform-fake-token",
        },
      });
      const out = res.stdout + res.stderr;
      assert.equal(res.status, 0, out);
      assert.match(res.stdout, /GATE_PLATFORM=PASS/, "حكم المنصّة يُطبع بلا قيمة");
      assert.match(res.stdout, /أُنشئ توكن القاعدة PROD/);
      assert.match(out, /--dry-run: لن يُطبَّق/);
      assert.match(out, /GATE_IDENTITY=/, "بوابة الهوية تعمل حتى في التخطي (محلية بلا شبكة)");
      const log = fs.readFileSync(logFile, "utf8");
      assert.match(log, /auth\/tokens\?authorization=full-access&expiration=never/, "التوريد عبر Platform API");
      // لا تسريب: لا الرمز المسكوك ولا المضيف الكامل ولا اسم المؤسسة كاملًا.
      assert.doesNotMatch(out, new RegExp(MINTED_JWT));
      assert.doesNotMatch(out, /c2lnbmF0dXJl/);
      assert.doesNotMatch(out, /rofyd-elazamey/);
      assert.doesNotMatch(out, /elazamey/);
      // بلا gh/vercel في المعاينة إطلاقًا.
      assert.doesNotMatch(log, /^\S*gh /m);
      assert.doesNotMatch(log, /^\S*vercel /m);
    } finally {
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });

  test("التنفيذ الفعلي يمرّر الأدوار الثلاثة (PROD/CI/الجسر) إلى gh وvercel عبر stdin — بلا تسريب", () => {
    const { binDir, logFile } = makeFakes();
    try {
      const res = spawnSync("bash", ["scripts/mint-turso-token.sh", "--skip-verify"], {
        encoding: "utf8",
        input: "",
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          TURSO_PLATFORM_TOKEN: "platform-fake-token",
          // قيمة CI تمرّر كمدخل لاختبار فصل الأسمية في apply (وضع التخطي لا يسكّ CI).
          TURSO_AUTH_TOKEN_CI: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjaS10b2tlbiJ9.c2lnY2k",
        },
      });
      const out = res.stdout + res.stderr;
      assert.equal(res.status, 0, out);
      const log = fs.readFileSync(logFile, "utf8");
      assert.match(log, /secret set TURSO_DATABASE_URL --env production/);
      assert.match(log, /secret set TURSO_AUTH_TOKEN --env production/);
      assert.match(log, /secret set TURSO_AUTH_TOKEN_CI --env production/, "فصل الأسمية: دور CI على GitHub");
      assert.match(log, /env add TURSO_DATABASE_URL production/);
      assert.match(log, /env add TURSO_AUTH_TOKEN production/);
      assert.match(log, /env add TURSO_AUTH_TOKEN_PROD production/, "فصل الأسمية: دور PROD على Vercel");
      assert.doesNotMatch(out, new RegExp(MINTED_JWT));
      assert.doesNotMatch(out, /rofyd-elazamey/);
      // لا توكن المنصّة ينتقل أبدًا: قيمته لا تظهر ولا يحملها أي نداء gh/vercel
      // (سطور CURL تسجّل argv الوهمي بحكمها — الشهادة تُقتصر على خطوات التسليم).
      assert.doesNotMatch(out, /platform-fake-token/);
      const handoff = log.split("\n").filter((l) => /\/(gh|vercel) /.test(l)).join("\n");
      assert.doesNotMatch(handoff, /platform-fake-token/);
      assert.match(res.stdout, /حُدِّث السرّ/);
    } finally {
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });

  test("تعدد المؤسسات (personal+فريق): يمسح القراءة ويختر التي تحوي القاعدة بلا طباعة اسم", () => {
    const { binDir, logFile } = makeFakes();
    try {
      const res = spawnSync("bash", ["scripts/mint-turso-token.sh", "--dry-run", "--skip-verify"], {
        encoding: "utf8",
        input: "",
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          TURSO_PLATFORM_TOKEN: "platform-fake-token",
          FAKE_ORGS: '[{"slug":"acme","type":"personal"},{"slug":"elazamey","type":"team"}]',
        },
      });
      const out = res.stdout + res.stderr;
      assert.equal(res.status, 0, out);
      assert.match(res.stdout, /اختيرت مؤسسة واحدة تحوي قاعدة \(من 2 مؤسسة\)/);
      // المسح قراءة فقط: مؤسسة بلا قواعد تُستبعد ثم يُعاد استخدام جسم المؤسسة ذات القاعدة.
      const log = fs.readFileSync(logFile, "utf8");
      assert.match(log, /organizations\/acme\/databases/);
      assert.match(log, /organizations\/elazamey\/databases/);
      assert.doesNotMatch(out, /acme/, "لا اسم مؤسسة في المخرج");
      assert.doesNotMatch(out, /elazamey/, "لا اسم مؤسسة في المخرج");
    } finally {
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });

  test("أكثر من سجل: الفروع (لها parent) تُصفّى وتُختار القاعدة الأساسية بلا طباعة اسم", () => {
    const { binDir, logFile } = makeFakes();
    try {
      const res = spawnSync("bash", ["scripts/mint-turso-token.sh", "--dry-run", "--skip-verify"], {
        encoding: "utf8",
        input: "",
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          TURSO_PLATFORM_TOKEN: "platform-fake-token",
          FAKE_DBS:
            '{"databases":[{"Name":"base-db","Hostname":"base-db-elazamey.turso.io"},' +
            '{"Name":"branch-a","Hostname":"branch-a-elazamey.turso.io","parent":{"id":"1"}},' +
            '{"Name":"branch-b","Hostname":"branch-b-elazamey.turso.io","parent":{"id":"1"}}]}',
        },
      });
      const out = res.stdout + res.stderr;
      assert.equal(res.status, 0, out);
      assert.match(res.stdout, /اختيرت القاعدة الأساسية الوحيدة \(من 3 سجلًا/);
      assert.doesNotMatch(out, /base-db-elazamey/, "لا مضيف كامل في المخرج");
      assert.doesNotMatch(out, /branch-a/, "لا اسم فرع في المخرج");
      const log = fs.readFileSync(logFile, "utf8");
      assert.match(log, /auth\/tokens\?authorization=full-access/, "تابع التوريد بعد الاختيار");
    } finally {
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });

  test("قواعد أساسية متعددة: فشل مغلق يطلب TURSO_DB أو vars.TURSO_DB دون تسريب اسم", () => {
    const { binDir, logFile } = makeFakes();
    try {
      const res = spawnSync("bash", ["scripts/mint-turso-token.sh", "--dry-run", "--skip-verify"], {
        encoding: "utf8",
        input: "",
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          TURSO_PLATFORM_TOKEN: "platform-fake-token",
          FAKE_DBS:
            '{"databases":[{"Name":"one-db","Hostname":"one-db-elazamey.turso.io"},' +
            '{"Name":"two-db","Hostname":"two-db-elazamey.turso.io"}]}',
        },
      });
      const out = res.stdout + res.stderr;
      assert.equal(res.status, 1, out);
      assert.match(out, /TURSO_DB/);
      assert.match(out, /vars\.TURSO_DB/);
      assert.match(out, /GATE_FAIL=PLATFORM/);
      assert.doesNotMatch(out, /one-db/, "لا اسم قاعدة في الفشل");
      assert.doesNotMatch(out, /two-db/, "لا اسم قاعدة في الفشل");
      const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
      assert.doesNotMatch(log, /^\S*gh /m);
    } finally {
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });

  test("بوابة الهوية fail-closed: توكن مسكوك لقاعدة أخرى يسقط قبل أي استدعاء gh/vercel", () => {
    const { binDir, logFile } = makeFakes();
    try {
      const res = spawnSync("bash", ["scripts/mint-turso-token.sh", "--skip-verify"], {
        encoding: "utf8",
        input: "",
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          TURSO_PLATFORM_TOKEN: "platform-fake-token",
          FAKE_JWT: MISMATCH_JWT,
        },
      });
      const out = res.stdout + res.stderr;
      assert.equal(res.status, 1, out);
      assert.match(out, /GATE_IDENTITY=(MISMATCH|FAIL)/);
      const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
      assert.doesNotMatch(log, /^\S*gh /m, "لا GitHub بعد مخالفة الهوية");
      assert.doesNotMatch(log, /^\S*vercel /m, "لا Vercel بعد مخالفة الهوية");
      assert.doesNotMatch(out, /otherdb/, "اللادّعاء المخالف لا يُطبع كاملًا (قناع)");
    } finally {
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });
});

describe("scripts/check-db-identity.mjs — بوابة الهوية (وحدة)", () => {
  const b64u = (s: string) => Buffer.from(s, "utf8").toString("base64url");
  const jwt = (payload: object) => `eyJhbGciOiJFZERTQSJ9.${b64u(JSON.stringify(payload))}.c2ln`;
  const runId = (env: Record<string, string>) =>
    spawnSync("node", ["scripts/check-db-identity.mjs"], { encoding: "utf8", env: { ...process.env, ...env } });

  test("ادّعاء مطابق يمرّ بحكم PASS مقنَّن", () => {
    const res = runId({
      MINTED_DB_TOKEN: jwt({ db: "rofyd", org: "elazamey" }),
      EXPECTED_DB: "rofyd",
      EXPECTED_ORG: "elazamey",
      EXPECTED_HOST: "rofyd-elazamey.turso.io",
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /GATE_IDENTITY=PASS/);
    assert.doesNotMatch(res.stdout, /rofyd|"db"/, "لا قيمة خام في الحكم");
  });

  test("مخالفة اسم القاعدة = فشل مغلق (exit 1) بقناع للجانبين", () => {
    const res = runId({ MINTED_DB_TOKEN: jwt({ db: "otherdb" }), EXPECTED_DB: "rofyd" });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /GATE_IDENTITY=MISMATCH/);
    assert.doesNotMatch(res.stderr, /otherdb/, "القِناع يمنع طباعة الادّعاء كاملًا");
  });

  test("مخالفة المؤسسة أو المضيف المشتق = فشل مغلق", () => {
    const r1 = runId({ MINTED_DB_TOKEN: jwt({ db: "rofyd", org: "evil-org" }), EXPECTED_DB: "rofyd", EXPECTED_ORG: "elazamey" });
    assert.equal(r1.status, 1);
    assert.match(r1.stderr, /GATE_IDENTITY=MISMATCH/);
    const r2 = runId({
      MINTED_DB_TOKEN: jwt({ db: "rofyd", org: "elazamey" }),
      EXPECTED_DB: "rofyd",
      EXPECTED_ORG: "elazamey",
      EXPECTED_HOST: "attacker.turso.io",
    });
    assert.equal(r2.status, 1);
    assert.match(r2.stderr, /GATE_IDENTITY=MISMATCH/);
  });

  test("توكن بلا ادّعاءي db/org يمرّ مع تعليل صريح (NO_CLAIMS) لا بصمت", () => {
    const res = runId({ MINTED_DB_TOKEN: jwt({ exp: 9999999999 }), EXPECTED_DB: "rofyd" });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /GATE_IDENTITY=NO_CLAIMS/);
  });

  test("مدخلات ناقصة أو رمز غير قابل للفك = BAD_INPUT (exit 2)", () => {
    assert.equal(runId({ EXPECTED_DB: "rofyd" }).status, 2);
    assert.equal(runId({ MINTED_DB_TOKEN: "not-a-jwt", EXPECTED_DB: "rofyd" }).status, 2);
  });
});

describe("scripts/migrate-turso.mjs — بوابة الهجرات الصريحة", () => {
  test("زوج محلي: تُطبَّق الهجرتان ثم تُعلن idempotency في التشغيل الثاني", () => {
    const dbFile = path.join(fs.mkdtempSync(path.join(tmpdir(), "mig-gate-")), "t.db");
    try {
      const r1 = spawnSync("node", ["--import", "tsx", "scripts/migrate-turso.mjs"], {
        encoding: "utf8",
        env: { ...process.env, TURSO_DATABASE_URL: `file:${dbFile}`, TURSO_AUTH_TOKEN: "" },
      });
      assert.equal(r1.status, 0, r1.stdout + r1.stderr);
      assert.match(r1.stdout, /MIGRATE_GATE=APPLIED count=2 versions=0001\+0002/);
      const r2 = spawnSync("node", ["--import", "tsx", "scripts/migrate-turso.mjs"], {
        encoding: "utf8",
        env: { ...process.env, TURSO_DATABASE_URL: `file:${dbFile}`, TURSO_AUTH_TOKEN: "" },
      });
      assert.equal(r2.status, 0, r2.stdout + r2.stderr);
      assert.match(r2.stdout, /MIGRATE_GATE=ALREADY/);
    } finally {
      fs.rmSync(path.dirname(dbFile), { recursive: true, force: true });
    }
  });

  test("بلا رابط مُمرَّر صراحةً = exit 2 (لا هجرة تلقائية من أي سياق)", () => {
    const res = spawnSync("node", ["--import", "tsx", "scripts/migrate-turso.mjs"], {
      encoding: "utf8",
      env: { ...process.env, TURSO_DATABASE_URL: "", TURSO_AUTH_TOKEN: "" },
    });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /MIGRATE_GATE=MISSING_ENV/);
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
