#!/usr/bin/env node
/**
 * يولّد وحدات TS من ملفات الهجرة المرجعية (.sql) حتى تعمل الهجرات مع
 * تجميع Next.js ومع اختبارات tsx معًا، ويضمن تطابق النصين (حاجز في CI).
 */
import fs from "node:fs";
import path from "node:path";

const dir = path.join(process.cwd(), "src", "lib", "db", "migrations");
const sqlFiles = fs.readdirSync(dir).filter((f) => f.endsWith(".sql"));

function tsContent(sql) {
  if (sql.includes("`") || sql.includes("${")) {
    throw new Error("Migration SQL must not contain backticks or ${} (conflicts with TS template literal).");
  }
  return `// مُولَّد آليًا من ملف الهجرة المرجعي — لا تعدّله يدويًا.\nexport const migrationSql = \`\n${sql}\n\` as string;\n`;
}

for (const sqlFile of sqlFiles) {
  const base = sqlFile.replace(/\.sql$/, "");
  const sql = fs.readFileSync(path.join(dir, sqlFile), "utf8");
  const tsPath = path.join(dir, `${base}.ts`);
  const expected = tsContent(sql);
  if (process.argv.includes("--check")) {
    const current = fs.existsSync(tsPath) ? fs.readFileSync(tsPath, "utf8") : "";
    if (current !== expected) {
      console.error(`Migration TS module out of sync: ${base}.ts — run: node scripts/sync-migrations.mjs`);
      process.exit(1);
    }
  } else {
    fs.writeFileSync(tsPath, expected);
    console.log(`synced ${base}.ts`);
  }
}
