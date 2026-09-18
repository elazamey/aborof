/**
 * حساب بصمات الهجرات بنفس خوارزمية `src/lib/db/migrate.ts` تمامًا.
 *
 * المصدر المرجعي هو ملفات `.sql` داخل `src/lib/db/migrations` (ووحدة `.ts`
 * المُولَّدة منها تُفحص في CI عبر `scripts/sync-migrations.mjs --check`).
 *
 * ملاحظة دقيقة: `migrate.ts` يحسب البصمة على قيمة القالب النصي في الوحدة
 * المُولَّدة، وقيمته = "\n" + نص ملف .sql + "\n" (سطر جديد بعد الفتحة
 * وقبل الإغلاق). لذا يجب أن تكون الصيغة نفسها هنا، وإلا ظهر تعارض وهمي
 * في فحص التطابق مع قاعدة الإنتاج.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export function migrationsDir(root = process.cwd()) {
  return path.join(root, "src", "lib", "db", "migrations");
}

/** البصمة المتوقعة لمحتوى هجرة كما يسجّلها مشغّل الهجرات في schema_migrations. */
export function migrationChecksum(sqlFileContent) {
  return createHash("sha256").update(`\n${sqlFileContent}\n`).digest("hex");
}

/**
 * قائمة الهجرات المتوقعة من الملفات المرجعية، مرتّبة حسب الإصدار.
 * @returns {{version: string, name: string, file: string, checksum: string}[]}
 */
export function expectedMigrations(root = process.cwd()) {
  const dir = migrationsDir(root);
  if (!fs.existsSync(dir)) throw new Error(`مجلد الهجرات غير موجود: ${dir}`);
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((file) => {
      const base = file.replace(/\.sql$/, "");
      const [version, ...rest] = base.split("_");
      return {
        version,
        name: rest.join("_") || version,
        file,
        checksum: migrationChecksum(fs.readFileSync(path.join(dir, file), "utf8")),
      };
    });
}

/** يستبدل أي سرّ بتسلسل حجب قبل طباعته (بدون تعبيرات نمطية). */
export function redact(text, secrets = []) {
  let out = String(text);
  for (const secret of secrets) {
    if (secret && String(secret).length >= 8) out = out.split(String(secret)).join("***");
  }
  return out;
}
