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
 * علم اختياري (يستخدمه CI فقط، والترميم مُعلَن في التقرير نفسه):
 *   --allow-dashboard-url   إذا كانت القيمة رابط لوحة تحكم (`app.turso.tech`)
 *                           لا رابط اتصال، تُشتق `<db>-<org>.turso.io` وتُجرَّب
 *                           فعلًا قبل استخدامها — بدل إسقاط كل الصفوف التابعة.
 *
 * الصفوف: conn · conn-token-shape (صيغة الرمز دائمًا) · conn-cause (السبب الخام
 * الموثّق عند فشل الاتصال: 401 رمز مرفوض مقابل 404 لا قاعدة) · ثم الهجرات
 * والصفوف 7–9 عند نجاح الاتصال.
 *
 * كود الخروج: 0 = كل الفحوص خضراء، 1 = فشل حاجب، 2 = تهيئة الفحص ناقصة.
 */
import { createClient } from "@libsql/client";
import { expectedMigrations, redact } from "./lib/migration-checksums.mjs";
import {
  dashboardUrlToConnectionCandidates,
  describeDatabaseUrl,
  interpretProbeStatus,
  originForHttpProbe,
  parseAuthValue,
} from "./lib/db-url.mjs";

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
const asJson = process.argv.includes("--json");
// ترميم الإعدادات (رابط لوحة تحكم بدل رابط اتصال، أو رابط في حقل الرمز) — بعلم صريح.
const allowDashboardUrl =
  process.argv.includes("--allow-dashboard-url") || process.argv.includes("--allow-secret-repair");

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
let effectiveUrl = url;
if (!local && !authToken) {
  console.error("❌ TURSO_AUTH_TOKEN مطلوب لأي رابط غير محلي (libsql:// أو https://).");
  process.exit(2);
}

const rows = [];
function record(id, label, ok, detail) {
  rows.push({ id, label, ok, detail });
}

/** تصنيف خطأ محاولة اتصال — تصنيف فقط، بلا طباعة قيمة الرابط ولا الرمز. */
function classifyConnectionError(error) {
  const text = String(error?.message ?? error);
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|fetch failed|dns/i.test(text)) return "المضيف غير موجود (DNS)";
  if (/\b40[13]\b|unauthor|forbidden|token|auth/i.test(text)) return "الرمز مرفوض أو غير كافٍ";
  if (/\b404\b|not found/i.test(text)) return "المضيف موجود ولا قاعدة بهذا الاسم";
  return "خطأ اتصال آخر";
}

/**
 * ترميم محدود ومعلن: إذا كانت القيمة المضبوطة رابط لوحة تحكم لا رابط اتصال،
 * نجرّب الروابط المرشّحة واحدة واحدة (اتصال `SELECT 1` فعلي) ونعيد أول عميل
 * ينجح. لا تُطبع أي قيمة مشتقة؛ التقرير يذكر النمط وتصنيف الفشل فقط.
 */
/**
 * نداء HTTP خام (نقطة hrana `POST /v2/pipeline`) بطلب `SELECT 1` — الأخطر أن
 * الفرق بين 404 و401 هو الفرق بين «أنشئ القاعدة» و«جدّد الرمز»، وهما علاجان
 * مختلفان تمامًا يخفي `@libsql/client` كليهما وراء رسالة SERVER_ERROR واحدة.
 * لا يُطبع الرد؛ فقط رمز الحالة والحكم المُترجَم منه.
 */
/**
 * وصف آمن لبنية الرابط عند فشل الاتصال — بلا قيمة الرابط وبلا رمزه.
 * (نص خطأ @libsql/client نفسه، مثل `Unexpected token '<'`، يقول إن المضيف رد
 * HTML لا JSON؛ وهذا عرض مختلف تمامًا عن «رمز غير صالح» أو «شبكة محجوبة».)
 */
async function diagnoseEndpoint() {
  const shape = describeDatabaseUrl(url);
  const parts = [
    `بنية الرابط: ${shape.scheme} · ${shape.kind} · المضيف ${shape.hostMasked} (طول ${shape.hostLength}) · مقاطع المسار ${shape.pathShape} · طول الرابط ${shape.length}` +
      (shape.hasPlaceholder ? " · يحتوي علامة موضع (<…> أو ... أو xx) فهو قيمة موضعية لا رابط حقيقي" : ""),
  ];
  const origin = originForHttpProbe(url);
  if (!origin) return parts;
  const guard = [...secrets, origin];
  try {
    const res = await fetch(origin, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(8_000) });
    const body = redact(String(await res.text()).slice(0, 160).replace(/\s+/g, " ").trim(), guard);
    parts.push(`استجابة أصل الرابط: HTTP ${res.status} · content-type: ${res.headers.get("content-type") ?? "—"} · body: ${body || "—"}`);
  } catch (e) {
    parts.push(`تعذّر الوصول إلى أصل الرابط: ${redact(String(e?.message ?? e), guard)}`);
  }
  return parts;
}

async function probeHttpEndpoint(candidateUrl, token) {
  const origin = originForHttpProbe(candidateUrl);
  if (!origin) return { ok: false, verdict: "رابط غير قابل للفحص عبر HTTP" };
  try {
    const res = await fetch(`${origin}/v2/pipeline`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        requests: [{ type: "execute", stmt: { sql: "SELECT 1 AS ok" } }, { type: "close" }],
      }),
      signal: AbortSignal.timeout(8_000),
    });
    const body = await res.text().catch(() => "");
    return interpretProbeStatus(res.status, redact(body, [...secrets, candidateUrl]));
  } catch (error) {
    const raw = redact(String(error?.message ?? error).slice(0, 120), [...secrets, candidateUrl]);
    return { ok: false, verdict: `تعذّر الوصول للخادم (شبكة/DNS) — ${raw}` };
  }
}

async function attemptDerivedConnection() {
  const authParts = parseAuthValue(authToken);

  // أزواج (رابط، رمز) مرتّبة من الأرجح إلى الأقل: الزوج المتسق المستخرج من قيمة
  // حقل الرمز أولًا (فهو خطأ اللصق الأكثر شيوعًا)، ثم اشتقاق مسار اللوحة مع كل رمز.
  const pairs = [];
  const add = (candidateUrl, token, label) => {
    if (!candidateUrl) return;
    const key = `${candidateUrl}\u0000${token ?? ""}`;
    if (pairs.some((p) => p.key === key)) return;
    pairs.push({ key, candidateUrl, token, label });
  };
  if (authParts.url && authParts.token) add(authParts.url, authParts.token, "زوج مستخرج من قيمة حقل الرمز");
  for (const candidateUrl of dashboardUrlToConnectionCandidates(url)) {
    if (authParts.token) add(candidateUrl, authParts.token, "رابط مشتق من مسار اللوحة + رمز مستخرج من حقل الرمز");
    add(candidateUrl, authToken, "رابط مشتق من مسار اللوحة + الرمز المضبوط");
  }
  if (authParts.url) add(authParts.url, authToken, "رابط مستخرج من حقل الرمز + الرمز المضبوط");

  if (pairs.length === 0) {
    return { client: null, note: "لا يمكن اشتقاق رابط اتصال من هذه القيمة (بنية مسار غير معروفة) — انسخ الرابط من زر Connect في لوحة Turso" };
  }

  const failures = [];
  for (const pair of pairs) {
    // 1) الفحص الخام أولًا ليُعرف السبب (لا قاعدة / رمز) لا مجرد «فشل اتصال».
    const verdict = await probeHttpEndpoint(pair.candidateUrl, pair.token);
    if (!verdict.ok) {
      failures.push(`${pair.label}: ${verdict.verdict}`);
      continue;
    }
    // 2) ثم المسار الحقيقي: نفس عميل التطبيق على نفس الزوج.
    const client = createClient({ url: pair.candidateUrl, authToken: pair.token });
    try {
      await client.execute("SELECT 1 AS ok");
      return { client, candidateUrl: pair.candidateUrl, token: pair.token, label: pair.label, note: "" };
    } catch (error) {
      const raw = redact(String(error?.message ?? error).slice(0, 120), [...secrets, pair.candidateUrl, pair.token]);
      failures.push(`${pair.label}: المسار الخام نجح وعميل libsql فشل — ${raw}`);
      client.close();
    }
  }
  return {
    client: null,
    note: `جُرّبت ${pairs.length} تركيبة على نمط <db>-<org>.turso.io: ${failures.map((f, i) => `${i + 1}) ${f}`).join(" · ")}`,
  };
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

/**
 * صف صيغة الرمز — يُسجَّل **دائمًا** للقواعد غير المحلية (لا في وضع الترميم فقط):
 * غيابه كان غموضًا (هل الرمز JWT سليم مرفوض الصلاحية، أم قيمة في غير محلها؟)،
 * وحضوره بشكله الموجب ينفي الصيغة ويوجّه العلاج (رمز جديد لنفس القاعدة).
 * الوصف شكلي فقط (النوع/الطول/الموضع) — لا يُطبع أي جزء من القيمة.
 */
function recordTokenShape() {
  if (local) return;
  const authParts = parseAuthValue(authToken);
  if (authParts.shape.looksLikeJwt) {
    record(
      "conn-token-shape",
      "صيغة قيمة TURSO_AUTH_TOKEN",
      true,
      `JWT بثلاثة مقاطع (طول ${authParts.shape.length}) — الصيغة سليمة؛ أي رفض بعده سببه الصلاحية/الانتهاء/القاعدة الخطأ لا الصيغة`
    );
  } else {
    record(
      "conn-token-shape",
      "صيغة قيمة TURSO_AUTH_TOKEN",
      false,
      authParts.shape.scheme
        ? `ليست رمز JWT بل قيمة تبدأ بـ ${authParts.shape.scheme}:// (النقطتان في الموضع ${authParts.shape.colonOffset} من ${authParts.shape.length} حرفًا) — رابط في حقل الرمز · **انقل الرابط إلى TURSO_DATABASE_URL ورمز JWT إلى TURSO_AUTH_TOKEN**`
        : `ليست بصيغة JWT المعتادة (طول ${authParts.shape.length}) · **أنشئ توكنًا جديدًا Full access**`
    );
  }
}

// تهيئة العميل داخل حماية: قيمة معطوبة (بلا مخطّط صالح) تجعل `createClient`
// نفسه يرمي — وكان الرمي هنا يُسقط السكربت قبل طباعة الجدول، ورسالة الخطأ تحمل
// القيمة المضبوطة حرفيًا. الآن تُسجَّل منقّحة في صف conn مع وصف البنية.
let db = null;
try {
  db = createClient({ url, authToken });
} catch (error) {
  const details = await diagnoseEndpoint();
  recordTokenShape();
  record(
    "conn",
    "الاتصال بقاعدة البيانات (SELECT 1)",
    false,
    [`تعذّرت تهيئة عميل libsql من القيمة المضبوطة: ${redact(String(error?.message ?? error), secrets)}`, ...details].join(" · ")
  );
  render();
  process.exit(1);
}

try {
  // 1) الاتصال — نفس مسار @libsql/client المستخدم في الإنتاج.
  let connected = false;
  try {
    await db.execute("SELECT 1 AS ok");
    connected = true;
    record("conn", "الاتصال بقاعدة البيانات (SELECT 1)", true, local ? "رابط ملف محلي" : `libsql متصل (${describeDatabaseUrl(effectiveUrl).kind})`);
    recordTokenShape();
  } catch (error) {
    // الفشل هنا يوقف الفحوص التابعة (لا معنى لها بلا اتصال) لكنه **لا يمنع
    // طباعة الجدول**: الجدول نفسه هو الدليل، فيُضاف إليه وصف بنية الرابط
    // واستجابة أصله. لا يُطبع الرابط ولا الرمز — الوصف كله عبر `redact`.
    const details = await diagnoseEndpoint();
    recordTokenShape();

    // ترميم مُعلَن (بعلم صريح): قيمة لوحة تحكم بدل رابط اتصال.
    if (allowDashboardUrl) {
      const derived = await attemptDerivedConnection();
      if (derived.client) {
        db.close();
        db = derived.client;
        effectiveUrl = derived.candidateUrl;
        secrets.push(derived.candidateUrl, derived.token);
        connected = true;
        record(
          "conn",
          "الاتصال بقاعدة البيانات (SELECT 1)",
          true,
          `متصل عبر ترميم مؤقت (${derived.label}) ⇒ القاعدة والرمز **سليمان**؛ المشكلة في مكان القيم لا في القاعدة · **صحّح TURSO_DATABASE_URL/TURSO_AUTH_TOKEN في الإعدادات لإزالة الترميم**`
        );
      } else {
        record("conn-derived", "اشتقاق رابط الاتصال من قيمة لوحة التحكم", false, derived.note);
      }
    }

    if (!connected) {
      record("conn", "الاتصال بقاعدة البيانات (SELECT 1)", false, [redact(String(error?.message ?? error), secrets), ...details].join(" · "));
      // السبب الخام **الموثّق**: عميل libsql يغلّف 401 و404 و400 في SERVER_ERROR
      // واحدة بلا حكم، وفحص الأصل أعلاه بلا ترويسة مصادقة (401 متوقعة منه دائمًا).
      // هذا الصف يرسل الطلب نفسه **مع الرمز المضبوط** فيميّز «رمز مرفوض (401 —
      // جدّد الرمز)» من «لا قاعدة بهذا الاسم (404 — تحقق من الاسم)» — وهما
      // علاجان مختلفان تمامًا. (فحص 2026-09-28: 401 برمز JWT سليم الشكل.)
      if (!local) {
        const cause = await probeHttpEndpoint(url, authToken);
        record(
          "conn-cause",
          "السبب الخام من الخادم (طلب موثّق بالرمز المضبوط)",
          cause.ok,
          cause.ok
            ? `${cause.verdict} — لكن عميل libsql فشل على الزوج نفسه؛ راجع نص خطأ صف conn`
            : cause.verdict
        );
      }
    }
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
  if (db) db.close();
}
