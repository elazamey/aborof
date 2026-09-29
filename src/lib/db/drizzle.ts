/**
 * عميل Drizzle الشفاف فوق Turso/libSQL — لا يكسر بوابة الهجرات.
 *
 * - يقرأ نفس `TURSO_DATABASE_URL` و `TURSO_AUTH_TOKEN` عبر `db()` الحالي.
 * - لا يُنشئ اتصالًا جديدًا؛ يلتفّ حول نفس `Client` من `@libsql/client`.
 * - `runMigrations` تبقى هي البوابة الوحيدة لتغيير البنية (0001+0002).
 * - الاستخدام: `const d = getDrizzle(); if (!d) return fallback; await d.select().from(products)…`
 *
 * في الاختبارات استخدم `setDbClientForTest` ثم `getDrizzle()` — سيلتفّ حول
 * العميل المحقون نفسه (ملف مؤقت)، فلا حاجة لإعداد منفصل.
 */

import { drizzle as drizzleLibsql, type LibSQLDatabase } from "drizzle-orm/libsql";
import { db } from "./index";
import * as schema from "./schema";

let _drizzle: LibSQLDatabase<typeof schema> | null = null;
let _drizzleForClient: unknown = null;

export type DrizzleDB = LibSQLDatabase<typeof schema>;

/**
 * يعيد نسخة Drizzle ملتفة حول نفس عميل libSQL الحالي، أو `null` إن لم تكن
 * قاعدة البيانات مهيأة (نفس سلوك `db()` — يعيد fallback في الإنتاج).
 * - مع `TURSO_DATABASE_URL` غير مُعيَّن → null
 * - مع رابط لوحة تحكم → يرمي (نفس سلوك `db()`)
 */
export function getDrizzle(): DrizzleDB | null {
  const client = db();
  if (!client) return null;
  // إعادة الاستخدام ما دام نفس العميل — يمنع تسريب اتصالات في الاختبارات.
  if (_drizzle && _drizzleForClient === client) return _drizzle;
  _drizzle = drizzleLibsql(client, { schema });
  _drizzleForClient = client;
  return _drizzle;
}

/**
 * للاختبارات: يلغي التخزين المؤقت (يُستدعى ضمن `setDbClientForTest`).
 * لا يُستدعى مباشرة في كود الإنتاج.
 */
export function resetDrizzleForTest(): void {
  _drizzle = null;
  _drizzleForClient = null;
}

export { schema };
export * from "./schema";
