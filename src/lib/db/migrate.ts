import { createHash } from "node:crypto";
import type { Client } from "@libsql/client";
import { ensureProductSearchInSync } from "@/lib/search";

/**
 * مشغّل هجرات مُرقّمة (versioned migrations).
 * كل هجرة تُسجَّل في جدول schema_migrations باسم و checksum، وتُنفَّذ مرة
 * واحدة فقط داخل معاملة. يحل هذا محل إنشاء/تعديل الجداول وقت التشغيل.
 */

export interface Migration {
  version: string;
  name: string;
  sql: string;
}

/**
 * الهجرات مضمّنة كوحدات TS حتى تعمل مع تجميع Next.js وتحت الاختبارات.
 * الملف المرجعي المُوثَّق هو `migrations/0001_initial.sql`؛ وملف الـ .ts
 * يُولَّد منه (انظر scripts) ويحمل نفس النص للتنفيذ.
 */
import { migrationSql as migration0001Sql } from "./migrations/0001_initial";
import { migrationSql as migration0002Sql } from "./migrations/0002_search_fts5";
import { migrationSql as migration0003Sql } from "./migrations/0003_order_idempotency";

export const MIGRATIONS: Migration[] = [
  { version: "0001", name: "initial", sql: migration0001Sql },
  { version: "0002", name: "search_fts5", sql: migration0002Sql },
  { version: "0003", name: "order_idempotency", sql: migration0003Sql },
];

function checksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

/**
 * يستخرج تعليمات `-- @ensure-columns:<name> <definition>` من نص الهجرة
 * ويضيف الأعمدة الناقصة للجداول القائمة (ALTER TABLE ADD COLUMN آمن في SQLite
 * عند وجود العمود يُتخطى عبر فحص PRAGMA). يدعم حاليًا جدول orders.
 */
async function ensureColumns(client: Client, sql: string) {
  const lines = sql.split("\n");
  const wanted: { column: string; definition: string }[] = [];
  for (const line of lines) {
    const m = line.match(/@ensure-columns:(\w+)\s+(.+)$/);
    if (m) wanted.push({ column: m[1], definition: m[2].trim() });
  }
  if (!wanted.length) return;
  const info = await client.execute("PRAGMA table_info(orders)");
  const existing = new Set(info.rows.map((r) => String((r as { name?: unknown }).name)));
  for (const { column, definition } of wanted) {
    if (!existing.has(column)) {
      await client.execute(`ALTER TABLE orders ADD COLUMN ${column} ${definition}`);
    }
  }
}

/**
 * يُشغّل الهجرات المتبقية. بعد النجاح يضمن بناء فهرس FTS5 (هجرة 0002) وحال
 * عدم توفره على المحرك يسقط بصمت دون إفشال التجهيز. الأعمدة الناقصة للجداول
 * القائمة تُعالَج بعد الهجرة (idempotent).
 */
export async function runMigrations(client?: Client): Promise<{ applied: string[] }> {
  // استيراد كسول: يكسر دورة الاستيراد مع وحدة قاعدة البيانات ويسمح بحقن
  // عميل في الاختبارات دون تهيئة مدخل البيئة.
  const { db } = await import("./index");
  const c = client ?? db();
  if (!c) return { applied: [] };

  await c.execute(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);

  const appliedRows = await c.execute("SELECT version, checksum FROM schema_migrations");
  const applied = new Map<string, string>(
    appliedRows.rows.map((r) => [String((r as { version?: unknown }).version), String((r as { checksum?: unknown }).checksum)])
  );

  const newlyApplied: string[] = [];
  for (const migration of MIGRATIONS) {
    const expected = checksum(migration.sql);
    const known = applied.get(migration.version);
    if (known) {
      if (known !== expected) {
        throw new Error(
          `Migration ${migration.version} checksum mismatch — راجع ملفات الهجرة قبل المتابعة.`
        );
      }
      continue;
    }
    // نفّذ عبارات الهجرة داخل دفعة ذرية واحدة (batch write = معاملة واحدة).
    // أزل أسطر التعليقات (بما فيها توجيهات @ensure-columns) قبل التقسيم على ';'.
    const statements = migration.sql
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .split(";")
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter((s) => s.length > 0);

    const batchStatements: { sql: string; args?: (string | number | null)[] }[] = [
      ...statements.map((sql) => ({ sql })),
      {
        sql: "INSERT INTO schema_migrations (version,name,checksum) VALUES (?,?,?)",
        args: [migration.version, migration.name, expected],
      },
    ];
    await c.batch(batchStatements, "write");
    newlyApplied.push(migration.version);
  }

  // الأعمدة الناقصة للجداول القديمة تُعالَج بعد الهجرة (idempotent).
  await ensureColumns(c, MIGRATIONS.map((m) => m.sql).join("\n"));

  // ضمان مزامنة فهرس البحث (هجرة 0002) مع الكتالوج بعد أي تجهيز.
  await ensureProductSearchInSync(c);

  return { applied: newlyApplied };
}
