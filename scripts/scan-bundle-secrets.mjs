#!/usr/bin/env node
/**
 * فحص تسريب الأسرار إلى **حزمة العميل** بعد البناء.
 *
 * سبب الحاجة: بوابة `security:gates` تفحص المصدر، لكن التسريب الحقيقي يظهر
 * في الأثر المبنيّ `.next/static` (وهو ما ينزّله المتصفح). اختبار كهذا هو
 * الفحص الوحيد الذي يجيب مباشرة على سؤال: «هل يمكن لزائر أن يقرأ سرًّا من
 * ملفات الموقع؟».
 *
 * ما يفحصه:
 *  1. أسماء أسرار الخادم داخل الحزمة (ظهور الاسم نفسه يعني وصول كود الخادم للعميل).
 *  2. مع `--check-env`: القيم الحقيقية للأسرار الموجودة في بيئة البناء (طول >= 8).
 *
 * الاستخدام:
 *   node scripts/scan-bundle-secrets.mjs                 # يفحص .next/static (يُشغَّل بعد npm run build)
 *   node scripts/scan-bundle-secrets.mjs --dir <path>    # مجلد مخصص (للاختبارات)
 *   node scripts/scan-bundle-secrets.mjs --check-env     # ابحث أيضًا عن القيم الحقيقية من البيئة
 *   node scripts/scan-bundle-secrets.mjs --json
 *
 * كود الخروج: 0 = نظيف (أو لا حزمة مبنيّة)، 1 = وُجد تسريب، 2 = استخدام خاطئ.
 * لا تُطبع أي قيمة سرية إطلاقًا — أسماء الملفات وأسماء المتغيرات فقط.
 */
import fs from "node:fs";
import path from "node:path";

const USAGE = `الاستخدام: node scripts/scan-bundle-secrets.mjs [--dir <path>] [--check-env] [--json]`;

const args = process.argv.slice(2);
function arg(name, fallback = null) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
}
const flag = (name) => args.includes(name);

if (flag("--help") || flag("-h")) {
  console.log(USAGE);
  process.exit(0);
}

const unknown = args.filter((a, i) => a.startsWith("--") && !["--dir", "--check-env", "--json", "--help", "-h"].includes(a));
if (unknown.length) {
  console.error(`❌ وسائط غير معروفة: ${unknown.join(", ")}\n${USAGE}`);
  process.exit(2);
}

/** أسماء أسرار الخادم — ظهورها في حزمة العميل عرضٌ لا يقبل التبرير. */
export const SERVER_SECRET_NAMES = [
  "ADMIN_SESSION_SECRET",
  "ADMIN_PASSWORD",
  "DIAGNOSTICS_KEY",
  "TURSO_AUTH_TOKEN",
  "TURSO_DATABASE_URL",
  "VERCEL_TOKEN",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "NVIDIA_NIM_API_KEY",
  "NVIDIA_API_KEY",
];

const TEXT_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".css", ".html", ".json", ".map", ".txt"]);
const MIN_VALUE_LENGTH = 8;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (TEXT_EXTENSIONS.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

/**
 * يبحث عن أسماء الأسرار في ملف واحد، وعن القيم الحقيقية إن طُلب ذلك.
 * مُصدَّرة للاختبار في tests/deploy-tools.test.ts.
 */
export function scanTextForSecrets(text, secretValues = []) {
  const hits = [];
  for (const name of SERVER_SECRET_NAMES) {
    if (text.includes(name)) hits.push({ kind: "name", label: name });
  }
  for (const { label, value } of secretValues) {
    if (value && value.length >= MIN_VALUE_LENGTH && text.includes(value)) {
      hits.push({ kind: "value", label });
    }
  }
  return hits;
}

function collectSecretValues() {
  const values = [];
  for (const name of SERVER_SECRET_NAMES) {
    const value = process.env[name];
    if (value && value.length >= MIN_VALUE_LENGTH) values.push({ label: name, value });
  }
  return values;
}

function main() {
  const dir = path.resolve(arg("--dir", path.join(process.cwd(), ".next", "static")));
  const asJson = flag("--json");

  if (!fs.existsSync(dir)) {
    // لا حزمة مبنيّة: ليس تسريبًا — يُطبع تنبيه فقط حتى يبقى الأمر صالحًا قبل `npm run build`.
    const report = { dir, scanned: 0, findings: [], skipped: true };
    if (asJson) console.log(JSON.stringify(report, null, 2));
    else console.log(`ℹ️ لا حزمة في ${dir} — شغّل \`npm run build\` أولًا. لا حكم.`);
    process.exit(0);
  }

  const secretValues = flag("--check-env") ? collectSecretValues() : [];
  const files = walk(dir);
  const findings = [];

  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    const hits = scanTextForSecrets(text, secretValues);
    for (const hit of hits) {
      findings.push({ file: path.relative(dir, file), kind: hit.kind, label: hit.label });
    }
  }

  const report = {
    dir,
    scanned: files.length,
    checkedEnvValues: secretValues.map((v) => v.label),
    findings,
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else if (findings.length === 0) {
    console.log(
      `✅ لا تسريب أسرار في حزمة العميل (${files.length} ملفًا فُحصت${flag("--check-env") ? " + قيم البيئة" : ""}).`
    );
  } else {
    console.error(`❌ وُجد ${findings.length} أثرًا لأسرار الخادم في حزمة العميل (${dir}):`);
    for (const f of findings.slice(0, 25)) {
      console.error(`  - ${f.file} — ${f.kind === "name" ? "اسم السر" : "قيمة السر"}: ${f.label}`);
    }
    if (findings.length > 25) console.error(`  … و${findings.length - 25} أثرًا آخر.`);
    console.error("\nالإجراء: افحص سلسلة الاستيراد — مكوّن عميل يستورد وحدة خادم (auth/db/secrets/orders).");
  }

  process.exit(findings.length === 0 ? 0 : 1);
}

const invokedDirectly = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) main();
