import { defineConfig } from "drizzle-kit";

/**
 * إعداد Drizzle Kit — طبقة TypeScript الشفافة فوق Turso/libSQL.
 *
 * - `schema` هو المصدر الوحيد للحقيقة من حيث الأنواع (Type Safety).
 * - `out` هو مجلد هجرات Drizzle المنفصل؛ لا يمسّ مجلد الهجرات الحتمي
 *   الذي يبقى المرجع (بوابة الهجرات `runMigrations` + بصمات sha256).
 * - `dialect: "turso"` يضمن توليد SQL متوافق مع libSQL (وليس SQLite العام).
 *
 * للتحقق من التطابق:
 *   npm run db:generate   # يولّد SQL في src/lib/db/drizzle
 *   npm run db:check       # يتحقق من تطابق المخطط مع قاعدة البيانات
 *
 * ملاحظة: لا يُشغَّل `drizzle-kit migrate` في الإنتاج — الهجرات الحتمية
 * تُطبَّق فقط عبر `runMigrations` (0001+0002) كما في `scripts/apply-migrations.mjs`.
 */
export default defineConfig({
  schema: "./src/lib/db/schema.ts",
  out: "./src/lib/db/drizzle",
  dialect: "turso",
  dbCredentials: {
    url: process.env.TURSO_DATABASE_URL || "file:./.drizzle-local.db",
    authToken: process.env.TURSO_AUTH_TOKEN,
  },
  verbose: true,
  strict: true,
});
