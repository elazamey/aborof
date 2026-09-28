#!/usr/bin/env node
/**
 * فحص Turso: الاتصال + تطابق الهجرات + صفوف DEPLOYMENT.md (7 و8 و9).
 *
 *   TURSO_DATABASE_URL=libsql://... TURSO_AUTH_TOKEN=... node scripts/verify-turso.mjs
 *
 * لتجربة الملف محليًا بلا أسرار (نفس مسار الفحص بالكامل):
 *   TURSO_DATABASE_URL=file:/tmp/aborof-check.db node scripts/verify-turso.mjs
 *
 * الفحص **للقراءة فقط**: لا ينفّذ أي هجرة ولا أي كتابة. أي ❌ يعني تهيئة ناقصة
 * على البيئة الحيّة، وليس خللًا في قاعدة البيانات نفسها.
 *
 * كود الخروج: 0 = كل الفحوص خضراء، 1 = فشل حاجب، 2 = تهيئة الفحص ناقصة.
 */
import { createClient } from "@libsql/client";
import { expectedMigrations, redact } from "./lib/migration-checksums.mjs";
import { describeDatabaseUrl, originForHttpProbe } from "./lib/db-url.mjs";

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
const asJson = process.argv.includes("--json");

if (!url) {
  console.error(
    [
      "❌ TURSO_DATABASE_URL غير مُعيَّن.",
      "شغّل بأسرار الإنتاج (لا تُكتب في ملف متتبَّع ولا في سجل الأوامر):",
      "  TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... node scripts/verify-turso.mjs",
      "أو بلا أسرار على نسخة محلية للتحقق من منطق الفحص: TURSO_DATABASE_URL=file:/tmp/aborof-check.db",
    ].join("\n")
  );
  process.exit(2);
}

const secrets = [url, authToken];
const local = url.startsWith("file:");
if (!local && !authToken) {
  console.error("❌ TURSO_AUTH_TOKEN مطلوب لأي رابط غير محلي (libsql:// أو https://).");
  process.exit(2);
}

const rows = [];
function record(id, label, ok, detail) {
  rows.push({ id, label, ok, detail });
}

/**
 * وصف آمن لبنية الرابط عند فشل الاتصال — بلا قيمة الرابط وبلا رمزه.
 * (نص خطأ @libsql/client نفسه، مثل `Unexpected token '<'`، يقول إن المضيف رد
 * HTML لا JSON؛ وهذا عرض مختلف تمامًا عن «رمز غير صالح» أو «شبكة محجوبة».)
 */
async function diagnoseEndpoint() {
  const shape = describeDatabaseUrl(url);
  const parts = [
    `بنية الرابط: ${shape.scheme} · ${shape.kind} · المضيف ${shape.hostMasked} · طول ${shape.length}` +
      (shape.hasPlaceholder ? " · يحتوي علامة موضع (<…> أو ... أو xx) فهو قيمة موضعية لا رابط حقيقي" : ""),
  ];
  const origin = originForHttpProbe(url);
  if (!origin) return parts;
  const guard = [...secrets, origin];
  try {
    const res = await fetch(origin, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(10_000) });
    const body = redact(String(await res.text()).slice(0, 160).replace(/\s+/g, " ").trim(), guard);
    parts.push(`استجابة أصل الرابط: HTTP ${res.status} · content-type: ${res.headers.get("content-type") ?? "—"} · body: ${body || "—"}`);
  } catch (e) {
    parts.push(`تعذّر الوصول إلى أصل الرابط: ${redact(String(e?.message ?? e), guard)}`);
  }
  return parts;
}

/** يطبع الجدول (أو JSON) مرة واحدة — يستدعيه المسار العادي ومسار فشل الاتصال. */
function render() {
  const failed = rows.filter((r) => !r.ok);
  if (asJson) {
    console.log(JSON.stringify({ ok: failed.length === 0, local, rows }, null, 2));
    return;
  }
  console.log(`# فحص Turso — ${local ? "قاعدة ملف محلي" : "قاعدة الإنتاج"}\n`);
  console.log("| # | الفحص | النتيجة | التفصيل |");
  console.log("|---|---|---|---|");
  for (const row of rows) {
    console.log(`| ${row.id} | ${row.label} | ${row.ok ? "✅" : "❌"} | ${row.detail.replace(/\|/g, "\\|")} |`);
  }
  console.log(
    failed.length === 0
      ? "\n✅ كل الفحوص خضراء: الاتصال يعمل، والهجرات متطابقة، وفهرس FTS5 متزامن مع الكتالوج."
      : `\n❌ فشل ${failed.length} فحصًا — راجع DEPLOYMENT.md (الصفوف 7–9 وإصلاح P0) قبل إعلان الجاهزية.`
  );
  if (!local) {
    console.log("\nملاحظة: الفحص للقراءة فقط ولم يُطبَّق أي شيء. التطبيق نفسه يشغّل الهجرات عند أول طلب (`ensureSchema`).");
  }
}

const db = createClient({ url, authToken });

try {
  // 1) الاتصال — نفس مسار @libsql/client المستخدم في الإنتاج.
  let connected = false;
  try {
    await db.execute("SELECT 1 AS ok");
    connected = true;
    record("conn", "الاتصال بقاعدة البيانات (SELECT 1)", true, local ? "رابط ملف محلي" : `libsql متصل (${describeDatabaseUrl(url).kind})`);
  } catch (error) {
    // الفشل هنا يوقف الفحوص التابعة (لا معنى لها بلا اتصال) لكنه **لا يمنع
    // طباعة الجدول**: الجدول نفسه هو الدليل، فيُضاف إليه وصف بنية الرابط
    // واستجابة أصله. لا يُطبع الرابط ولا الرمز — الوصف كله عبر `redact`.
    const details = await diagnoseEndpoint();
    record("conn", "الاتصال بقاعدة البيانات (SELECT 1)", false, [redact(String(error?.message ?? error), secrets), ...details].join(" · "));
  }

  if (!connected) {
    render();
    process.exit(1);
  }

  // 2) جدول الهجرات نفسه.
  const applied = new Map();
  let migrationsTable = false;
  try {
    const r = await db.execute("SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version");
    migrationsTable = true;
    for (const row of r.rows) {
      applied.set(String(row.version), {
        name: String(row.name),
        checksum: String(row.checksum),
        appliedAt: String(row.applied_at ?? ""),
      });
    }
    record("mig-table", "جدول schema_migrations موجود", true, `${applied.size} هجرة مسجّلة`);
  } catch (error) {
    record("mig-table", "جدول schema_migrations موجود", false, `غير موجود — لم تُشغَّل الهجرات على هذه القاعدة (${redact(String(error?.message ?? error), secrets)})`);
  }

  // 3) تطابق الهجرات: كل هجرة في المستودع مسجّلة في القاعدة بنفس البصمة.
  const expected = expectedMigrations(process.cwd());
  const problems = [];
  if (migrationsTable) {
    for (const migration of expected) {
      const found = applied.get(migration.version);
      if (!found) {
        problems.push(`${migration.version}_${migration.name}: غير مطبَّقة على القاعدة`);
      } else if (found.checksum !== migration.checksum) {
        problems.push(`${migration.version}_${migration.name}: بصمة مختلفة عن المستودع (الملف عُدّل بعد التطبيق!)`);
      }
    }
    for (const version of applied.keys()) {
      if (!expected.some((m) => m.version === version)) problems.push(`${version}: مسجَّلة في القاعدة وغير موجودة في المستودع`);
    }
  }
  record(
    "mig-parity",
    "تطابق الهجرات (المستودع ↔ القاعدة)",
    migrationsTable && problems.length === 0,
    migrationsTable
      ? problems.length
        ? problems.join(" | ")
        : `متطابقة: ${expected.map((m) => `${m.version}_${m.name}`).join(", ")}`
      : "تعذّر الفحص: لا يوجد جدول هجرات"
  );

  // 4) الصف 7: order_items موجودة (تثبيت إصلاح P0 بعد الدمج).
  const orderItems = await db.execute("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='order_items'");
  const hasOrderItems = Number(orderItems.rows[0]?.n ?? 0) > 0;
  let orderItemsCount = null;
  if (hasOrderItems) {
    const c = await db.execute("SELECT COUNT(*) AS n FROM order_items");
    orderItemsCount = Number(c.rows[0]?.n ?? 0);
  }
  record("row-7", "الصف 7 — SELECT COUNT(*) FROM order_items", hasOrderItems, hasOrderItems ? `${orderItemsCount} صفًا بلا خطأ no such table` : "الجدول غير موجود (إصلاح P0 لم يُفعَّل)");

  // 5) الصف 8: جدول FTS5 الافتراضي product_search موجود (هجرة 0002).
  const search = await db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='product_search'");
  const hasSearch = search.rows.length > 0;
  record("row-8", "الصف 8 — وجود product_search (هجرة 0002/FTS5)", hasSearch, hasSearch ? "الجدول الافتراضي موجود" : "غير موجود — هجرة 0002 لم تُطبَّق على هذه البيئة");

  // 6) الصف 9: الفهرس متزامن مع الكتالوج.
  let productsCount = null;
  let searchCount = null;
  let synced = false;
  if (hasSearch) {
    const p = await db.execute("SELECT COUNT(*) AS n FROM products");
    const s = await db.execute("SELECT COUNT(*) AS n FROM product_search");
    productsCount = Number(p.rows[0]?.n ?? 0);
    searchCount = Number(s.rows[0]?.n ?? 0);
    synced = productsCount === searchCount;
    record("row-9", "الصف 9 — COUNT(product_search) = COUNT(products)", synced, `products=${productsCount} / product_search=${searchCount}`);
  } else {
    record("row-9", "الصف 9 — COUNT(product_search) = COUNT(products)", false, "غير قابل للفحص: product_search غائب");
  }

  // 7) سياق مساعد: الجداول الأساسية الأخرى (بلا حكم على النجاح).
  const tables = await db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
  const names = tables.rows.map((r) => String(r.name));
  const essentials = ["products", "orders", "order_items", "faq", "chat_logs", "admin_audit_log", "rate_limit_counters"];
  const missingEssentials = essentials.filter((t) => !names.includes(t));
  record("tables", "الجداول الأساسية للمتجر", missingEssentials.length === 0, missingEssentials.length ? `ناقصة: ${missingEssentials.join(", ")}` : `${essentials.length} جدولًا حاضرًا`);

  render();
  process.exit(rows.filter((r) => !r.ok).length === 0 ? 0 : 1);
} catch (error) {
  if (!asJson) console.error(`❌ توقف الفحص: ${redact(String(error?.message ?? error), secrets)}`);
  process.exit(1);
} finally {
  db.close();
}
