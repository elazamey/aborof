#!/usr/bin/env node
/**
 * بوابة الملفات الإلزامية للواجهة (المرحلة الأولى) — تمنع تراجعًا صامتًا:
 * حذف حدّ خطأ أو إسقاط ميتاداتا المنتج لا يظهر في أي اختبار آخر، لكنه يترك
 * المستخدم أمام صفحة بيضاء أو منتجًا غير قابل للفهرسة.
 *
 * ما تتحقق منه:
 *  1. وجود حدود الخطأ/التحميل/404 الأربعة في `src/app/`.
 *  2. `global-error.tsx` يُصدّر `<html>` و`<body>` (بدونهما يفشل العرض كليًا).
 *  3. `generateMetadata` موجودة في صفحة المنتج وتقرأ المنتج من `@/lib/db`.
 *  4. `robots.ts` يحجب `/admin` و`/api`، و`sitemap.ts` يبني الروابط من المنتجات.
 *  5. `manifest.ts` لا يشير إلى أيقونة غير موجودة.
 *
 * الاستخدام: node scripts/check-front-mandatory.mjs [--json]
 * كود الخروج: 0 = كل شيء موجود، 1 = نقص حاجب.
 */
import fs from "node:fs";
import path from "node:path";

const asJson = process.argv.includes("--json");
const root = process.cwd();
const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null);

/**
 * يزيل تعليقات JS قبل أي فحص نصّي.
 * الدرس: تعليق يشرح «`await params`» كان يُحتسب دليلًا على وجود الكود، فتمرّ بوابة
 * كُتبت لمنع عطل إنتاجي حقيقي على كود مكسور. التعليقات ليست كودًا.
 */
const stripComments = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|\s)\/\/.*$/, "$1"))
    .join("\n");

const findings = [];
function require_(id, description, condition, detail = "") {
  findings.push({ id, description, ok: Boolean(condition), detail });
}

const app = path.join(root, "src", "app");
const boundaries = {
  "error.tsx": "حدّ خطأ على مستوى المسار",
  "not-found.tsx": "صفحة 404 مخصصة",
  "global-error.tsx": "حدّ الخطأ الجذري",
};
for (const [file, description] of Object.entries(boundaries)) {
  require_(file, description, fs.existsSync(path.join(app, file)));
}

// حدّ التحميل محصور في مجموعة الصفحة الرئيسية، لا في جذر `src/app/`.
require_("loading-home", "حالة تحميل للصفحة الرئيسية داخل (home)",
  fs.existsSync(path.join(app, "(home)", "loading.tsx")));
// خطأ إنتاجي حقيقي: حدّ تحميل جذري (أو في مسار المنتج) يجعل الردّ يُبثّ بحالة 200
// قبل حسم وجود المنتج ⇒ «404 ناعم» لكل منتج محذوف/رابط قديم، وهو ما ترفضه محركات البحث.
require_("no-loading-boundary-over-product",
  "لا حدّ تحميل يلفّ /product/[id] (يمنع 404 الناعم)",
  !fs.existsSync(path.join(app, "loading.tsx")) &&
  !fs.existsSync(path.join(app, "product", "loading.tsx")) &&
  !fs.existsSync(path.join(app, "product", "[id]", "loading.tsx")));

const globalError = read(path.join(app, "global-error.tsx")) ?? "";
require_("global-error-html", "global-error يصدّر <html> و<body>",
  globalError.includes("<html") && globalError.includes("<body"));

const errorBoundary = read(path.join(app, "error.tsx")) ?? "";
require_("error-client", "error.tsx مكوّن عميل (شرط Next.js)", /^["']use client["']/m.test(errorBoundary));
require_("error-no-raw-leak", "error.tsx لا يطبع نص الخطأ الكامل في وحدة التحكم",
  !/console\.error\(\s*["'][^"']*["']\s*,\s*error\s*\)/.test(errorBoundary));

const productPage = read(path.join(app, "product", "[id]", "page.tsx")) ?? "";
require_("product-metadata", "generateMetadata في صفحة المنتج", /export\s+async\s+function\s+generateMetadata/.test(productPage));
require_("product-metadata-db", "الميتاداتا تُبنى من مصدر المنتجات الحقيقي",
  /from\s+["']@\/lib\/db["']/.test(productPage));
require_("product-canonical", "canonical لصفحة المنتج", /canonical/.test(productPage));

const robots = read(path.join(app, "robots.ts")) ?? "";
require_("robots-admin", "robots يحجب /admin", /["'`]\/admin["'`]/.test(robots));
require_("robots-api", "robots يحجب /api", /["'`]\/api\/?["'`]/.test(robots));
require_("robots-sitemap", "robots يشير إلى خريطة الموقع", /sitemap/i.test(robots));

const sitemap = read(path.join(app, "sitemap.ts")) ?? "";
require_("sitemap-products", "sitemap يُبنى من المنتجات لا قائمة يدوية", /getProducts\s*\(/.test(sitemap));
require_("sitemap-absolute", "sitemap يستخدم روابط مطلقة", /absoluteUrl/.test(sitemap));

const manifest = read(path.join(app, "manifest.ts")) ?? "";
const iconRefs = [...manifest.matchAll(/src:\s*"([^"]+)"/g)].map((m) => m[1]);
const missingIcons = iconRefs.filter((src) => src.startsWith("/") && !fs.existsSync(path.join(app, src.replace(/^\//, ""))));
require_("manifest-icons", "كل أيقونة في المانيفست موجودة فعلًا", missingIcons.length === 0,
  missingIcons.length ? `مفقودة: ${missingIcons.join(", ")}` : "");

// خطأ إنتاجي حقيقي سابق: Next 16 يجعل params وعدًا؛ القراءة المتزامنة تُرجع
// id غير معرّف فتُسقط كل صفحات المنتجات إلى 404. هذه البوابة تمنع عودته صامتًا.
// تُجرَّد التعليقات أولًا، وإلا كفى تعليق يشرح «await params» لتمرير الملف المكسور.
const productCode = stripComments(productPage);
require_("product-params-awaited", "params تُقرأ بـawait في الصفحة وفي الميتاداتا",
  (productCode.match(/await\s+params\b/g) ?? []).length >= 2);
require_("product-params-promise", "نوع params معلن كـPromise (شكل Next 16)",
  /params:\s*Promise</.test(productCode));
require_("product-params-no-sync-read", "لا قراءة متزامنة params.id في أي مكان",
  !/params\.id\b/.test(productCode));

const layout = read(path.join(app, "layout.tsx")) ?? "";
require_("layout-metadata-base", "metadataBase مضبوطة في الـlayout", /metadataBase/.test(layout));
require_("layout-canonical", "canonical افتراضي في الـlayout", /canonical/.test(layout));

const failed = findings.filter((f) => !f.ok);
if (asJson) {
  console.log(JSON.stringify({ ok: failed.length === 0, findings }, null, 2));
} else if (failed.length === 0) {
  console.log(`✅ بوابة الواجهة الإلزامية: ${findings.length} فحصًا كلها خضراء.`);
} else {
  console.error(`❌ بوابة الواجهة الإلزامية: ${failed.length} فحصًا فاشلًا من ${findings.length}:`);
  for (const f of failed) console.error(`  - ${f.id}: ${f.description}${f.detail ? ` — ${f.detail}` : ""}`);
}
process.exit(failed.length === 0 ? 0 : 1);
