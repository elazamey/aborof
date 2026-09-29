#!/usr/bin/env node
/**
 * بوابة الهجرات الصريحة — تطبيق هجرات المستودع (اليوم: 0001 و0002) على قاعدة
 * هدف بأمر واحد، بدل تركها لأول طلب في الإنتاج (`ensureSchema`).
 *
 * لماذا بوابة «صريحة»؟ لأن الهجرات كتابة على قاعدة الإنتاج، والكتابة لا تُنفَّذ
 * ضمنيًا داخل أداة تحقق: بلا `--apply` يعمل هذا الملف في وضع **الخطة** (قراءة
 * فقط)، فيُرى ما سيُطبَّق وما هو مطبَّق فعلًا وبأي بصمة — بلا أي تغيير.
 *
 * الاستخدام:
 *   node scripts/apply-migrations.mjs --url file:/tmp/x.db            # خطة على نسخة محلية
 *   node --import tsx scripts/apply-migrations.mjs --url file:/tmp/x.db --apply
 *   TURSO_DATABASE_URL='libsql://<db>-<org>.turso.io' TURSO_AUTH_TOKEN='eyJ…' \
 *     npm run migrations:apply                                        # على قاعدة الإنتاج
 *   npm run migrations:plan -- --expect 0001,0002 --json              # لخط أنابيب
 *
 * الأسوار (كلها قبل أي كتابة):
 *   1. الهدف يجب أن يكون رابط Turso/libSQL أو قاعدة محلية (`file:`) — رابط لوحة
 *      التحكم أو نطاق تطبيق أو قيمة موضعية لم تُستبدل ⇒ رفض صريح (وهو بعينه عطل
 *      الإعداد المرصود في الإنتاج: القيم في غير حقولها).
 *   2. الرمز يُقرأ من **بيئة العملية** (اسم المتغير `--token-env`) ولا يُقبل في
 *      argv إطلاقًا، ولا يُطبع في أي مخرج (`redact` تمرّ على كل رسالة خطأ).
 *   3. مسار التطبيق هو `runMigrations()` نفسه المستخدم في الإنتاج — لا SQL
 *      مكرَّر هنا، فلا مصدرَا حقيقة للمخطط.
 *   4. بعد التطبيق يُعاد الفحص: كل هجرة متوقعة مسجّلة بنفس بصمة المستودع، وكل
 *      إصدار مطلوب في `--expect` حاضر.
 *
 * حالات الصفوف: ✅ منفذ/متطابق · ⏳ معلَّق (متوقّع في وضع الخطة) · ❌ فشل.
 * كود الخروج: 0 أخضر أو خطة معلّقة · 1 فشل/انحراف · 2 تهيئة ناقصة · 3 مرفوض بالحاجز.
 */
import fs from "node:fs";
import process from "node:process";
import { describeDatabaseUrl } from "./lib/db-url.mjs";
import { expectedMigrations, redact } from "./lib/migration-checksums.mjs";
import { isLocalDatabaseUrl, maskTarget } from "./lib/turso-api.mjs";

const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const apply = argv.includes("--apply");

function flag(name) {
  return argv.includes(name);
}
function argValue(name, fallback = "") {
  const at = argv.indexOf(name);
  return at >= 0 && at + 1 < argv.length ? argv[at + 1] : fallback;
}

if (flag("-h") || flag("--help")) {
  const source = fs.readFileSync(new URL(import.meta.url), "utf8").split("\n");
  const lines = [];
  let started = false;
  for (const line of source) {
    if (!started) {
      if (line.startsWith("/**")) started = true;
      continue;
    }
    if (line.startsWith(" */")) break;
    lines.push(line.replace(/^ ?\* ?/, ""));
  }
  console.log(lines.join("\n"));
  process.exit(0);
}

/* ------------------------------------------------------------------ */
/* التقرير: ثلاث حالات، والحكم على الخروج من `fail` وحدها                */
/* ------------------------------------------------------------------ */

const rows = [];
function record(id, label, state, detail) {
  rows.push({ id, label, state, ok: state !== "fail", pending: state === "pending", detail: String(detail) });
}

let targetLine = "";
let footer = "";
function render() {
  if (asJson) {
    console.log(JSON.stringify({ ok: rows.every((row) => row.state !== "fail"), mode: apply ? "apply" : "plan", rows }, null, 2));
    return;
  }
  console.log(`### 🧱 بوابة الهجرات الصريحة — وضع ${apply ? "التطبيق (--apply)" : "الخطة (قراءة فقط)"}`);
  console.log();
  if (targetLine) {
    console.log(`🎯 ${targetLine}`);
    console.log();
  }
  console.log("| # | الفحص | النتيجة | التفصيل |");
  console.log("|---|---|---|---|");
  for (const row of rows) {
    const mark = row.state === "fail" ? "❌" : row.state === "pending" ? "⏳" : "✅";
    console.log(`| ${row.id} | ${row.label} | ${mark} | ${row.detail.replace(/\|/g, "\\|")} |`);
  }
  if (footer) {
    console.log();
    console.log(footer);
  }
}

function finish(code) {
  render();
  process.exit(code);
}

/* ------------------------------------------------------------------ */
/* 1) الحاجز الأول: الهدف                                               */
/* ------------------------------------------------------------------ */

const url = String(argValue("--url") || process.env.TURSO_DATABASE_URL || "").trim();
const tokenEnvName = String(argValue("--token-env") || process.env.TURSO_TOKEN_ENV || "TURSO_AUTH_TOKEN").trim();
const token = String(process.env[tokenEnvName] || "").trim();
// كل قيمة قد تظهر في رسالة خطأ تُحجب بها قبل الطباعة.
const secrets = [url, token].filter((value) => value.length >= 8);

if (!url) {
  console.error(
    [
      "❌ MIGRATIONS_TARGET_MISSING: TURSO_DATABASE_URL غير مُعيَّن ولا --url ممرَّر.",
      "على قاعدة الإنتاج (القيم من البيئة، لا من سطر الأوامر):",
      "  TURSO_DATABASE_URL='libsql://<db>-<org>.turso.io' TURSO_AUTH_TOKEN='eyJ…' npm run migrations:apply",
      "محليًا للتجربة: node --import tsx scripts/apply-migrations.mjs --url file:/tmp/x.db --apply",
      "ولسكّ الرمز + تطبيق الهجرات + ضبط الأسرار بأمر واحد: bash scripts/mint-turso-token.sh",
    ].join("\n")
  );
  process.exit(2);
}

const local = isLocalDatabaseUrl(url);
const shape = describeDatabaseUrl(url);
const masked = maskTarget({ url });
targetLine = `الهدف: ${masked.url} · ${masked.urlShape ? masked.urlShape.kind : "—"} · طول الرابط ${shape.length}`;

if (!local && shape.hasPlaceholder) {
  console.error(
    `❌ MIGRATIONS_TARGET_PLACEHOLDER: القيمة المضبوطة موضع من التوثيق لم يُستبدل (${shape.scheme}:// · المضيف ${shape.hostMasked} · طول ${shape.length}).`
  );
  process.exit(3);
}

if (!local && shape.kind !== "Turso" && shape.kind !== "libsql.io") {
  const looksLikeDashboard = /app\.turso\.(tech|io)$/i.test(String(url).replace(/^[a-z]+:\/\//i, "").split("/")[0]);
  console.error(
    [
      `❌ MIGRATIONS_TARGET_REFUSED: الهدف ليس قاعدة Turso بل ${shape.kind} (المضيف ${shape.hostMasked} · طول المضيف ${shape.hostLength}).`,
      looksLikeDashboard
        ? "هذا رابط لوحة تحكم لا رابط اتصال — انسخه من زر Connect، أو شغّل bash scripts/mint-turso-token.sh ليشتقّ الرابط من ردّ الخادم نفسه."
        : "بوابة الكتابة لا تلمس نطاقًا غير Turso: صحّح TURSO_DATABASE_URL (الصيغة libsql://<db>-<org>.turso.io) ثم أعد.",
    ].join("\n")
  );
  process.exit(3);
}

if (!local && !token) {
  console.error(
    `❌ MIGRATIONS_TOKEN_MISSING: ${tokenEnvName} غير مُعيَّن والهدف ليس قاعدة محلية — لا كتابة بلا رمز (يُقرأ من البيئة فقط، لا من argv).`
  );
  process.exit(2);
}

record(
  "target",
  "هدف الهجرات مقبول",
  "ok",
  local
    ? "قاعدة محلية (file:) — للتجربة لا للإنتاج"
    : `${shape.scheme}:// · المضيف ${shape.hostMasked} (طول ${shape.hostLength}) · نوع ${shape.kind} · الرمز من ${tokenEnvName} (طول ${token.length})`
);

/* ------------------------------------------------------------------ */
/* 2) المتوقع في المستودع، والمطلوب صراحةً                               */
/* ------------------------------------------------------------------ */

let expected;
try {
  expected = expectedMigrations(process.cwd());
} catch (error) {
  console.error(`❌ تعذّرت قراءة ملفات الهجرات: ${redact(String(error?.message ?? error), secrets)}`);
  process.exit(2);
}

const expectArg = String(argValue("--expect") || "").trim();
const requested = expectArg
  ? expectArg
      .split(",")
      .map((version) => version.trim())
      .filter(Boolean)
  : expected.map((migration) => migration.version);
const unknown = requested.filter((version) => !expected.some((migration) => migration.version === version));
if (unknown.length) {
  console.error(
    `❌ --expect يطلب إصدارًا غير موجود في المستودع: ${unknown.join("، ")} — المتاح: ${expected
      .map((migration) => `${migration.version}_${migration.name}`)
      .join("، ")}`
  );
  process.exit(2);
}

record(
  "plan",
  "الهجرات المتوقعة من المستودع",
  expected.length ? "ok" : "fail",
  `${expected.map((migration) => `${migration.version}_${migration.name} (بصمة ${migration.checksum.slice(0, 12)}…)`).join(" · ")}${
    expectArg ? ` — المطلوب صراحة: ${requested.join("، ")}` : ""
  }`
);

/* ------------------------------------------------------------------ */
/* 3) الاتصال والقراءة المسبقة (بلا كتابة في وضع الخطة)                   */
/* ------------------------------------------------------------------ */

const { createClient } = await import("@libsql/client");
const client = createClient(local ? { url } : { url, authToken: token });

async function readApplied() {
  try {
    const result = await client.execute("SELECT version, name, checksum FROM schema_migrations ORDER BY version");
    return {
      exists: true,
      map: new Map(
        result.rows.map((row) => [String(row.version), { name: String(row.name), checksum: String(row.checksum) }])
      ),
    };
  } catch {
    return { exists: false, map: new Map() };
  }
}

try {
  await client.execute("SELECT 1");
  record("conn", "الاتصال بالهدف (SELECT 1)", "ok", local ? "قاعدة محلية" : "اتصال ناجح بالرمز الممرَّر عبر البيئة");
} catch (error) {
  record("conn", "الاتصال بالهدف (SELECT 1)", "fail", redact(String(error?.message ?? error), secrets));
  client.close();
  finish(1);
}

const before = await readApplied();
const pendingBefore = expected.filter((migration) => !before.map.has(migration.version));
record(
  "before",
  "الحالة قبل التطبيق",
  "ok",
  before.exists
    ? `${before.map.size} هجرة مسجّلة · المعلَّق: ${pendingBefore.map((migration) => `${migration.version}_${migration.name}`).join("، ") || "لا شيء"}`
    : "لا جدول schema_migrations بعد (قاعدة لم تُهجَّر)"
);

/* ------------------------------------------------------------------ */
/* 4) التطبيق — المسار الإنتاجي نفسه (runMigrations)                     */
/* ------------------------------------------------------------------ */

let newlyApplied = [];
if (!apply) {
  record(
    "apply",
    "تطبيق الهجرات",
    pendingBefore.length ? "pending" : "ok",
    pendingBefore.length
      ? `وضع الخطة: لن تُطبَّق ${pendingBefore.map((migration) => `${migration.version}_${migration.name}`).join("، ")} — للتطبيق: --apply`
      : "وضع الخطة: لا شيء معلَّق أصلًا"
  );
} else if (!pendingBefore.length) {
  record("apply", "تطبيق الهجرات", "ok", "لا شيء للتطبيق — كل هجرات المستودع مسجّلة على الهدف");
} else {
  let runMigrations;
  try {
    ({ runMigrations } = await import("../src/lib/db/migrate.ts"));
  } catch (error) {
    console.error(
      [
        `❌ تعذّر تحميل مشغّل الهجرات (ملف TS): ${redact(String(error?.message ?? error), secrets)}`,
        "التطبيق يحتاج محمّل tsx — شغّل: node --import tsx scripts/apply-migrations.mjs --apply",
        "أو: npm run migrations:apply (بعد npm ci لتوفر devDependencies).",
      ].join("\n")
    );
    client.close();
    process.exit(2);
  }
  try {
    const result = await runMigrations(client);
    newlyApplied = result?.applied ?? [];
    record(
      "apply",
      "تطبيق الهجرات (runMigrations)",
      "ok",
      newlyApplied.length ? `طُبِّقت الآن: ${newlyApplied.join("، ")}` : "لم تُطبَّق هجرة جديدة (المخطط محدَّث)"
    );
  } catch (error) {
    // التفصيل في الصفوف التالية؛ هنا تُحجب كل قيمة سرية في الرسالة.
    record("apply", "تطبيق الهجرات (runMigrations)", "fail", redact(String(error?.message ?? error), secrets));
  }
}

/* ------------------------------------------------------------------ */
/* 5) الفحص البعدي: التطابق مع المستودع                                  */
/* ------------------------------------------------------------------ */

const after = apply ? await readApplied() : before;
const problems = [];
if (!after.exists) {
  problems.push("لا جدول schema_migrations");
} else {
  for (const migration of expected) {
    const found = after.map.get(migration.version);
    if (!found) problems.push(`${migration.version}_${migration.name}: غير مطبَّقة`);
    else if (found.checksum !== migration.checksum) {
      problems.push(`${migration.version}_${migration.name}: بصمة مختلفة عن المستودع (عُدّل الملف بعد التطبيق!)`);
    }
  }
  for (const version of after.map.keys()) {
    if (!expected.some((migration) => migration.version === version)) {
      problems.push(`${version}: مسجّلة في القاعدة وغير موجودة في المستودع`);
    }
  }
}
const parityOk = after.exists && problems.length === 0;
record(
  "parity",
  "تطابق البصمات (المستودع ↔ القاعدة)",
  parityOk ? "ok" : apply || before.exists ? "fail" : "pending",
  parityOk
    ? `متطابقة: ${expected.map((migration) => `${migration.version}_${migration.name}`).join("، ")}`
    : `${problems.join(" | ")}${apply || before.exists ? "" : " (متوقّع في وضع الخطة على قاعدة لم تُهجَّر)"}`
);

const missingRequested = requested.filter((version) => !after.map.has(version));
record(
  "expect",
  `الإصدارات المطلوبة (${requested.join("، ")})`,
  missingRequested.length === 0 ? "ok" : apply || before.exists ? "fail" : "pending",
  missingRequested.length === 0
    ? `كلها مسجّلة على الهدف${newlyApplied.length ? ` — طُبِّق الآن: ${newlyApplied.join("، ")}` : ""}`
    : `ناقصة: ${missingRequested.join("، ")}${apply || before.exists ? "" : " (وضع الخطة — لم يُطبَّق شيء)"}`
);

// مزامنة FTS5 تتم في نهاية runMigrations، ويُقاس الفرق هنا كما يقيسه مجسّ CI
// (الصف 9) — قياس لا حكم إضافي على البيانات.
if (after.map.has("0002")) {
  try {
    const products = Number((await client.execute("SELECT COUNT(*) AS n FROM products")).rows[0]?.n ?? 0);
    const search = Number((await client.execute("SELECT COUNT(*) AS n FROM product_search")).rows[0]?.n ?? 0);
    record(
      "fts-sync",
      "مزامنة فهرس البحث (الصف 9)",
      products === search ? "ok" : "pending",
      `products=${products} / product_search=${search}${
        products === search ? "" : " — البذرة تُعبّأ عند أول طلب في الإنتاج فتُشفى الفجوة"
      }`
    );
  } catch (error) {
    record("fts-sync", "مزامنة فهرس البحث (الصف 9)", "fail", redact(String(error?.message ?? error), secrets));
  }
}

client.close();

if (!asJson && apply && !local) {
  footer = "➡️  بعد التطبيق: أعد مجسّ الأدلة لترى القاعدة كما تراها CI — npm run verify:turso";
}

finish(rows.some((row) => row.state === "fail") ? 1 : 0);
