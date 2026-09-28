#!/usr/bin/env node
/**
 * بوابات أمنية ثابتة (Static gates) — تعمل في CI كحاجز نشر:
 *
 *  1. فصل الأغراض: يُمنع استخدام ADMIN_SESSION_SECRET خارج وحدة الأسرار/الجلسات
 *     المسموح بها (لا يُشارَك مع التشخيص أو أي غرض آخر).
 *  2. منع تسريب الأخطاء: يُمنع إرجاع `String(e.message)` أو `e.stack` للعميل،
 *     ويُمنع `status: 200` مع حقل error في مسارات API.
 *  3. كل مسارات API تُغلَّف بـ apiHandler الموحّد.
 *  4. عزل العميل/الخادم: مكوّن عميل لا يستورد وحدة خادم فقط (auth/db/secrets/orders/rate-limit).
 *  5. لا تُطبع متغيرات البيئة الحساسة مباشرة في السجلات.
 *  6. ثوابت CSP: لا مصدر خارجي للخطوط أو السكربتات، و`frame-ancestors 'none'` قائمة،
 *     و`connect-src 'self'` أساسه — أي توسيع يحتاج تذكرة أمنية صريحة.
 *  7. أسطول الوكلاء (المرحلة الرابعة): الكتالوج بيانات لا سلوك — لا استيراد وحدات
 *     بيانات (db/orders/auth)، ولا أدوات خارج قائمة القراءة فقط المجمّدة هنا.
 */
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const problems = [];

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const files = walk(path.join(root, "src"));

/** ملفات كتالوج الأسطول — فحوص بنيوية خاصة بها (البند 6). */
const isFleetCatalogFile = (rel) => rel.includes(path.normalize("lib/ai/agents/catalog/"));

const SESSION_SECRET_ALLOWED = new Set([
  path.normalize("src/lib/auth.ts"),
  path.normalize("src/lib/secrets.ts"),
]);

/**
 * قائمة الأدوات المسموح بها لكتالوج الأسطول — **مجمّدة عمدًا**.
 * إضافة أداة جديدة تتطلب تعديل هذا الملف صراحةً (قرار واعٍ في المراجعة)،
 * ومطابقتها للسجل الحقيقي محميّة أيضًا باختبار في tests/agent-fleet.test.ts.
 * أي أداة كاتبة تظهر هنا = فشل بوابة فوري في CI، لا ملاحظة مراجعة.
 */
const FLEET_ALLOWED_TOOLS = new Set([
  "search_products",
  "lookup_faq",
  "shipping_estimate",
  "store_info",
  "orders_create",
  "products_upsert",
  "order_status_update",
]);
const FLEET_READ_ONLY_TOOLS = new Set(["search_products", "lookup_faq", "shipping_estimate", "store_info"]);
const FLEET_FORBIDDEN_IMPORTS = ["@/lib/db", "@/lib/orders", "@/lib/auth", "@/lib/secrets"];

/** وحدات خادم فقط — استيرادها من مكوّن عميل ممنوع (فحص العزل أعلاه). */
const SERVER_ONLY_MODULES = ["@/lib/auth", "@/lib/secrets", "@/lib/db", "@/lib/orders", "@/lib/rate-limit"];

for (const file of files) {
  const rel = path.relative(root, file);
  const norm = path.normalize(rel);
  const src = fs.readFileSync(file, "utf8");

  // 1) ADMIN_SESSION_SECRET فقط في الأماكن المسموحة.
  if (src.includes("ADMIN_SESSION_SECRET") && !SESSION_SECRET_ALLOWED.has(norm)) {
    problems.push(`${rel}: ADMIN_SESSION_SECRET يُستخدم خارج الوحدات المصرح لها (افصل الأغراض).`);
  }

  // 2) منع تسريب رسائل/تتبع الأخطاء للعملاء.
  if (/String\(\s*e[\s\S]{0,20}?\.?\s*message\s*\)/.test(src) && src.includes("NextResponse")) {
    // يُسمح داخل وحدات الأخطاء/الأسرار التي تعالج الإخفاء.
    if (!/lib[\\/]errors|lib[\\/]secrets/.test(norm)) {
      problems.push(`${rel}: احتمال تسريب String(e.message) للعميل — استخدم Errors/toErrorResponse.`);
    }
  }
  if (/\.stack/.test(src) && /NextResponse\.json/.test(src) && !/lib[\\/]errors/.test(norm)) {
    problems.push(`${rel}: stack trace قد يصل للعميل — امنعه عبر طبقة الأخطاء المركزية.`);
  }

  // 3) كل ملف route يجب أن يغلّف معالجاته عبر apiHandler.
  if (norm.includes(path.normalize("app/api")) && /route\.ts$/.test(norm)) {
    if (src.includes("export const POST") || src.includes("export const GET") ||
        src.includes("export const PATCH") || src.includes("export const DELETE")) {
      if (!src.includes("apiHandler(")) {
        problems.push(`${rel}: مسار API لا يستخدم apiHandler الموحّد.`);
      }
    }
  }

  // 4) عزل العميل/الخادم: مكوّن عميل (`use client`) لا يستورد وحدة خادم فقط،
  //    لأن ذلك هو الطريق الأول لتسرّب أسرار الخادم إلى حزمة المتصفح.
  if (/^\s*["']use client["']/m.test(src)) {
    for (const mod of SERVER_ONLY_MODULES) {
      if (src.includes(`from "${mod}"`) || src.includes(`from '${mod}'`)) {
        problems.push(`${rel}: مكوّن عميل يستورد وحدة خادم فقط (${mod}) — خطر تسريب أسرار إلى الحزمة.`);
      }
    }
  }

  // 6) كتالوج الأسطول: بيانات لا سلوك.
  if (isFleetCatalogFile(rel)) {
    for (const mod of FLEET_FORBIDDEN_IMPORTS) {
      if (src.includes(`from "${mod}"`) || src.includes(`from '${mod}'`)) {
        problems.push(`${rel}: كتالوج الأسطول يستورد وحدة بيانات/خادم (${mod}) — الكتالوج تعريفات فقط.`);
      }
    }
    if (/readOnly\s*:\s*false/.test(src)) {
      problems.push(`${rel}: تعريف وكيل يعلن أداة غير للقراءة فقط (readOnly: false).`);
    }
    for (const match of src.matchAll(/tools\s*:\s*\[([^\]]*)\]/g)) {
      for (const rawName of match[1].split(",")) {
        const name = rawName.trim().replace(/["'`]/g, "");
        if (!name) continue;
        if (!FLEET_ALLOWED_TOOLS.has(name)) {
          problems.push(`${rel}: أداة غير معروفة في تعريف وكيل (${name}) — أضفها صراحةً إلى قائمة البوابة.`);
        } else if (!FLEET_READ_ONLY_TOOLS.has(name)) {
          problems.push(`${rel}: أداة كاتبة في كتالوج الأسطول (${name}) — مرفوضة بنيويًا.`);
        }
      }
    }
  }

  // 5) منع طباعة أسرار البيئة في السجلات.
  if (/console\.(log|error|warn)\([^)]*process\.env\./.test(src) &&
      /SECRET|PASSWORD|TOKEN|KEY/.test(src.match(/console\.(log|error|warn)\([^)]*process\.env\.([A-Z_]+)/)?.[1] ?? "")) {
    problems.push(`${rel}: لا تطبع قيم البيئة الحساسة في السجلات.`);
  }
}

/**
 * ثوابت CSP — تُقرأ من وحدة السياسة نفسها (لا من نسخة نصية تتقادم)، وتُفرض
 * على وضعي الحجب والمراقبة معًا. أي إضافة مصدر خارجي للخطوط أو السكربتات،
 * أو إضعاف frame-ancestors، تُفشل البوابة في CI.
 */
const CSP_INVARIANTS = [
  { directive: "font-src", rule: "self-data-only", why: "الخطوط تُستضاف محليًا أو تكون خطوط نظام — لا Google Fonts" },
  { directive: "script-src", rule: "no-external-origin", why: "لا سكربتات طرف ثالث بلا تذكرة أمنية" },
  { directive: "frame-ancestors", rule: "must-be-none", why: "منع التأطير (clickjacking) غير قابل للتفاوض" },
  { directive: "object-src", rule: "must-be-none", why: "منع تضمين كائنات قابلة للتنفيذ" },
  { directive: "base-uri", rule: "self-data-only", why: "منع اختطاف المسارات النسبية" },
  { directive: "connect-src", rule: "self-present", why: "أي مصدر خارجي في connect-src يجب أن يكون مقصودًا ومراجعًا" },
];

function directiveSources(policy, directive) {
  const part = policy
    .split(";")
    .map((p) => p.trim())
    .find((p) => p.startsWith(directive + " "));
  if (!part) return null;
  return part.slice(directive.length).trim().split(/\s+/).filter(Boolean);
}

const isExternalOrigin = (source) => /^https?:\/\//.test(source) || source.startsWith("//");

const headersFile = path.join(root, "src", "lib", "security", "headers.ts");
if (fs.existsSync(headersFile)) {
  const headersSource = fs.readFileSync(headersFile, "utf8");
  const literal = headersSource.match(/const directives = \[([\s\S]*?)\];/);
  if (!literal) {
    problems.push("src/lib/security/headers.ts: تعذّر قراءة قائمة توجيهات CSP للفحص.");
  } else {
    // السلاسل بعلامات مزدوجة فقط، لأن القيم نفسها تحوي علامات مفردة مثل 'self'.
    // (استخراج بالعلامات المزدوجة حول مصدر واحد كان يبتلع النصف قبل 'self'.)
    const policy = [...literal[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]).join("; ");
    for (const invariant of CSP_INVARIANTS) {
      const sources = directiveSources(policy, invariant.directive);
      if (!sources) {
        problems.push(`CSP: التوجيه ${invariant.directive} غائب — ${invariant.why}`);
        continue;
      }
      const external = sources.filter(isExternalOrigin);
      if (invariant.rule === "must-be-none" && sources.join(" ") !== "'none'") {
        problems.push(`CSP: ${invariant.directive} يجب أن يكون 'none' — ${invariant.why}`);
      }
      if (invariant.rule === "self-data-only" && external.length > 0) {
        problems.push(`CSP: ${invariant.directive} يحتوي مصادر خارجية (${external.join(", ")}) — ${invariant.why}`);
      }
      if (invariant.rule === "no-external-origin" && external.length > 0) {
        problems.push(`CSP: ${invariant.directive} يحتوي مصادر خارجية (${external.join(", ")}) — ${invariant.why}`);
      }
      if (invariant.rule === "self-present" && !sources.includes("'self'")) {
        problems.push(`CSP: ${invariant.directive} يجب أن يحوي 'self' — ${invariant.why}`);
      }
    }
  }
}

if (problems.length) {
  console.error("❌ Security gates failed:\n");
  for (const p of problems) console.error("  - " + p);
  console.error(`\n${problems.length} gate(s) failed.`);
  process.exit(1);
}
console.log(`✅ Security gates passed (${files.length} source files checked).`);
