/**
 * سياسة الهجرات: إضافية افتراضيًا، وbackfill مُصرَّح استثناءً مُحكَمًا.
 *
 * النموذج (EXPAND → BACKFILL → CONTRACT):
 *   - `DROP/RENAME/TRUNCATE` ممنوعة **دائمًا** بلا استثناء.
 *   - `UPDATE/DELETE` مرفوضة في ملفات الهجرات العادية، ومسموحة **فقط** في
 *     ملف `*_backfill.sql` يحمل بيانات وصفية كاملة (فلا يصبح اللاحق ثغرة
 *     لأي تعديل عشوائي — `migration_id` هو اسم الملف نفسه):
 *       -- @backfill:approved: <مرجع PR أو قضية>
 *       -- @backfill:purpose: <لماذا؟ سطر واحد>
 *       -- @backfill:owner: <المسؤول>
 *       -- @backfill:batch_limit: <عدد صحيح>
 *       -- @backfill:expected_rows: <التقدير>
 *       -- @backfill:rollback: <استراتيجية التراجع نصًا>
 *       -- @backfill:verification_query: <استعلام تحقق SELECT>
 *       UPDATE ... WHERE ... LIMIT <n>;   -- كل عبارة طافرة محدودة
 * القيد الصريح: «المحدودية» نحوية (وجود LIMIT) — الرقم المناسب مسؤولية
 * مراجعة الـ PR لا هذه الدالة. دالة نقية تُختبَر بسلاسل مصنوعة.
 *
 * @param {string} file اسم الملف (يُستخدَم للتمييز والإبلاغ فقط)
 * @param {string} sql نص الهجرة الكامل
 * @returns {string[]} قائمة انتهاكات (فارغة = مقبولة)
 */
/** يجرّد تعليقات SQL (السطرية والكتلية) قبل فحص العبارات. */
export function stripSqlComments(sql) {
  return String(sql ?? "")
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

export function checkMigrationSql(file, sql) {
  const violations = [];
  const raw = String(sql ?? "");
  const stripped = stripSqlComments(raw);

  if (/\bDROP\s+(TABLE|COLUMN|INDEX|TRIGGER|VIEW)\b/i.test(stripped)) {
    violations.push(`${file}: DROP ممنوع دائمًا — أي إسقاط يكون في نافذة صيانة مُعلَنة خارج الهجرات (انظر PRODUCTION-CONTRACT.md §3)`);
  }
  if (/\bALTER\s+TABLE\s+\S+\s+(DROP|RENAME)\b/i.test(stripped)) {
    violations.push(`${file}: ALTER TABLE بـ DROP/RENAME ممنوع — المسموح ADD COLUMN فقط`);
  }
  if (/\bRENAME\s+(TO|COLUMN)\b/i.test(stripped)) {
    violations.push(`${file}: RENAME ممنوع دائمًا — استخدم عمودًا جديدًا + نقل تدريجي`);
  }
  if (/\bTRUNCATE\b/i.test(stripped)) {
    violations.push(`${file}: TRUNCATE ممنوع دائمًا`);
  }

  const mutating = /\bUPDATE\s+\S+\s+SET\b/i.test(stripped) || /\bDELETE\s+FROM\b/i.test(stripped);
  if (!mutating) return violations;

  if (!/_backfill\.sql$/i.test(file)) {
    violations.push(`${file}: UPDATE/DELETE خارج ملف *_backfill.sql مرفوضة — الهجرات العادية إضافية فقط`);
    return violations;
  }
  // التصريح يُقرأ من النص الخام (التعليقات) — عمدًا، فهو إعلان مراجعة لا SQL.
  // البيانات الوصفية الإلزامية الست + migration_id (اسم الملف نفسه).
  const metaValue = (key) =>
    raw.match(new RegExp(`^--\\s*@backfill:${key}:\\s*(\\S[^\\n]*)`, "m"))?.[1]?.trim() ?? null;
  if (!metaValue("approved")) {
    violations.push(`${file}: غياب التصريح (-- @backfill:approved: <مرجع PR>)`);
  }
  if (!metaValue("rollback")) {
    violations.push(`${file}: غياب استراتيجية التراجع (-- @backfill:rollback: <نص>)`);
  }
  for (const key of ["purpose", "owner", "batch_limit", "expected_rows", "verification_query"]) {
    if (!metaValue(key)) violations.push(`${file}: غياب البيانات الوصفية (-- @backfill:${key}: …)`);
  }
  const batchLimit = metaValue("batch_limit");
  if (batchLimit !== null && !/^\d+$/.test(batchLimit)) {
    violations.push(`${file}: batch_limit يجب أن يكون عددًا صحيحًا (الدفعة محدودة رقميًا لا لفظيًا)`);
  }
  for (const stmt of stripped.split(";")) {
    const doesMutate = /\bUPDATE\s+\S+\s+SET\b/i.test(stmt) || /\bDELETE\s+FROM\b/i.test(stmt);
    if (doesMutate && !/\bLIMIT\s+\d+/i.test(stmt)) {
      violations.push(`${file}: عبارة طافرة بلا حدّ (LIMIT) مرفوضة: ${stmt.trim().replace(/\s+/g, " ").slice(0, 70)}…`);
    }
  }
  return violations;
}
