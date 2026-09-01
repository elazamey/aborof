/**
 * Pre-deploy migration check — يُشغَّل قبل النشر ضد قاعدة بيانات الإنتاج.
 * يطبّق الهجرات الناقصة (نفس src/lib/migrations.ts — لا تكرار للـ SQL)
 * ويفشل (exit 1) عند أي خطأ: قاعدة "migration failure → deployment FAIL".
 *
 * التشغيل:  node --experimental-strip-types scripts/migrate-check.mts
 * البيئة:   TURSO_DATABASE_URL (+ TURSO_AUTH_TOKEN للمواقع البعيدة)
 */
import { createClient } from "@libsql/client";
import { applyMigrations, SCHEMA_VERSION } from "../src/lib/migrations.ts";

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  if (!url) {
    console.error("[migrate] TURSO_DATABASE_URL is required");
    process.exit(1);
  }
  const client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });
  try {
    const version = await applyMigrations(client);
    console.log(`[migrate] OK — schema version ${version} (required ${SCHEMA_VERSION})`);
    if (version !== SCHEMA_VERSION) {
      console.error("[migrate] VERSION MISMATCH — deployment must fail");
      process.exit(1);
    }
    process.exit(0);
  } catch (error) {
    console.error("[migrate] FAILED — deployment blocked:", error);
    process.exit(1);
  }
}

main();
