#!/usr/bin/env node
/**
 * بوابة الهجرات **الصريحة** — لا هجرة وقت البناء، ولا هجرة على أول طلب
 * مستخدم: خطوة مستقلة تُستدعى صراحةً بين «تحقّق من الاتصال» و«طبّق الأسرار»
 * (mint-turso-token.sh تستدعيها في transacted sequence — راجع ترويسة ذلك الملف).
 *
 *   TURSO_DATABASE_URL=libsql://… TURSO_AUTH_TOKEN=eyJ… \
 *     node --import tsx scripts/migrate-turso.mjs
 *
 * العقود:
 *   - idempotent: ما طُبّق مسبقًا لا يُعاد (نفس سلوك runMigrations)، وخطأ
 *     بصمة هجرة قائم = فشل مغلق (exit 3) لا تخطّي.
 *   - بلا هجرة بلا زوج مُمرَّر صراحةً (exit 2) — لا يقرأ `.env` ولا يخترع
 *     اتصالًا.
 *   - لا يطبع أي قيمة: المخرج عدّاد الإصدارات (أسماء عامة في المستودع) وأحكام.
 *
 * رموز الخروج: 0 = طُبّقت أو كانت مطبَّقة · 2 = تهيئة ناقصة · 3 = فشل الهجرة.
 */
import { createClient } from "@libsql/client";
import { runMigrations } from "../src/lib/db/migrate";

const url = process.env.TURSO_DATABASE_URL;
const token = process.env.TURSO_AUTH_TOKEN;

if (!url) {
  console.error("❌ MIGRATE_GATE=MISSING_ENV — TURSO_DATABASE_URL غير معيّن؛ لا هجرة بلا زوج مُمرَّر صراحةً.");
  process.exit(2);
}
if (!url.startsWith("file:") && !token) {
  console.error("❌ MIGRATE_GATE=MISSING_ENV — TURSO_AUTH_TOKEN مطلوب لأي رابط غير محلي.");
  process.exit(2);
}

const client = createClient({ url, authToken: token || undefined });
try {
  const { applied } = await runMigrations(client);
  if (applied.length) {
    console.log(`✅ MIGRATE_GATE=APPLIED count=${applied.length} versions=${applied.join("+")}`);
  } else {
    console.log("✅ MIGRATE_GATE=ALREADY — كل الهجرات مطبَّقة مسبقًا (idempotent).");
  }
  process.exit(0);
} catch (error) {
  console.error(`❌ MIGRATE_GATE=FAILED ${String(error?.message ?? error)}`);
  process.exit(3);
} finally {
  client.close();
}
