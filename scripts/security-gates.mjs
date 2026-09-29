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
 *  8. لوحة الصلاحيات (M1): حزمة `src/lib/rbac` خادم فقط (تُضاف إلى وحدات الخادم)،
 *     وبصمات كلمات المرور عبر scrypt لا دالة تجزئة سريعة، ولا `password_hash`
 *     خارج طبقة المخزن (الواجهة والمسارات لا تلمس العمود أبدًا).
 *  9. كتالوج الصلاحيات = نقاط الفرض: كل `requirePermission`/`actorCan` يذكر صلاحية
 *     معروفة في الكتالوج، وكل صلاحية في الكتالوج لها نقطة فرض فعلية في الكود —
 *     لا صلاحية معلنة بلا حارس، ولا حارس بصلاحية وهمية.
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
const SERVER_ONLY_MODULES = [
  "@/lib/auth",
  "@/lib/secrets",
  "@/lib/db",
  "@/lib/orders",
  "@/lib/rate-limit",
  // M1: حزمة الصلاحيات تلمس قاعدة البيانات وكلمات المرور ⇒ خادم فقط.
  "@/lib/rbac",
  // CeliaTokenManager: يقرأ البصمة ويكتب قاعدة البيانات ⇒ خادم فقط.
  "@/lib/celia/tokens",
];

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
 * 8) لوحة الصلاحيات: لا دالة تجزئة سريعة لكلمات المرور، ولا عمود البصمة خارج
 *    طبقة المخزن. القاعدتان تُفحصان نصيًا لأنهما ثابتان لا يعتمدان سياقًا.
 */
const passwordModule = path.join(root, "src", "lib", "rbac", "password.ts");
if (fs.existsSync(passwordModule)) {
  const source = fs.readFileSync(passwordModule, "utf8");
  if (!source.includes("scrypt")) {
    problems.push("src/lib/rbac/password.ts: بصمات كلمات المرور يجب أن تمرّ عبر scrypt.");
  }
  if (/createHash\(|md5|sha1\b/i.test(source)) {
    problems.push("src/lib/rbac/password.ts: دالة تجزئة سريعة لكلمة مرور (createHash/md5/sha1) — مرفوضة.");
  }
  if (!source.includes("timingSafeEqual")) {
    problems.push("src/lib/rbac/password.ts: المقارنة يجب أن تكون ثابتة الزمن (timingSafeEqual).");
  }
}
for (const file of files) {
  const rel = path.relative(root, file);
  const norm = path.normalize(rel);
  const src = fs.readFileSync(file, "utf8");
  const isApiRoute = norm.includes(path.normalize("app/api"));
  const isClientComponent = /^\s*["']use client["']/m.test(src);
  if ((isApiRoute || isClientComponent) && src.includes("password_hash")) {
    problems.push(`${rel}: عمود password_hash لا يُلمس خارج طبقة المخزن (src/lib/rbac/store.ts).`);
  }
  // نفس المبدأ للتوكنات: عمود البصمة يُلمس في وحدة واحدة فقط، فلا يظهر في
  // مسار API ولا في مكوّن عميل (ولا يمكن تسريبه في حزمة المتصفح).
  if ((isApiRoute || isClientComponent) && src.includes("token_hash")) {
    problems.push(`${rel}: عمود token_hash لا يُلمس خارج طبقة التوكنات (src/lib/celia/tokens.ts).`);
  }
}

/**
 * 8.b) CeliaTokenManager: النص الصريح للتوكن لا يدخل أي سجل أو تدقيق.
 *   يقينًا: أي استدعاء لـ`auditInsertStatement` في وحدة التوكنات يجب ألا يذكر
 *   `plaintext` (القيمة الحقيقية في الاستجابة فقط، لا في الأثر الدائم).
 */
const celiaTokensModule = path.join(root, "src", "lib", "celia", "tokens.ts");
if (fs.existsSync(celiaTokensModule)) {
  const src = fs.readFileSync(celiaTokensModule, "utf8");
  for (const match of src.matchAll(/auditInsertStatement\(([\s\S]{0,600}?)\}\)/g)) {
    if (/plaintext/.test(match[1])) {
      problems.push("src/lib/celia/tokens.ts: النص الصريح للتوكن يظهر في تفاصيل التدقيق — يُعرض مرة واحدة فقط.");
    }
  }
}

/**
 * 9) كتالوج الصلاحيات ↔ نقاط الفرض (اتجاهان، لا اتجاه واحد):
 *    - صلاحية مذكورة في حارس ولا توجد في الكتالوج ⇒ فشل.
 *    - صلاحية في الكتالوج بلا أي حارس في الكود ⇒ فشل (لا وعد بلا فرض).
 *    القراءة بالتعابير النصية لأن المصدر هو الكود نفسه، لا نسخة موازية.
 */
const permissionsModule = path.join(root, "src", "lib", "rbac", "permissions.ts");
if (fs.existsSync(permissionsModule)) {
  const source = fs.readFileSync(permissionsModule, "utf8");
  const catalogBlock = source.match(/export const RBAC_PERMISSIONS = \[([\s\S]*?)\] as const;/);
  const catalog = catalogBlock
    ? [...catalogBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
    : [];
  if (!catalog.length) {
    problems.push("src/lib/rbac/permissions.ts: تعذّر قراءة كتالوج الصلاحيات للفحص.");
  }
  const catalogSet = new Set(catalog);
  const enforced = new Map(); // permission -> أول ملف يفرضها
  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    const rel = path.relative(root, file);
    for (const match of src.matchAll(/(?:requirePermission|actorCan)\(\s*[A-Za-z_$][\w$]*\s*,\s*"([^"]+)"/g)) {
      if (!enforced.has(match[1])) enforced.set(match[1], rel);
    }
  }
  for (const [permission, file] of enforced) {
    if (!catalogSet.has(permission)) {
      problems.push(`${file}: يحرس صلاحية «${permission}» غير المدرجة في الكتالوج.`);
    }
  }
  for (const permission of catalog) {
    if (!enforced.has(permission)) {
      problems.push(`كتالوج الصلاحيات: «${permission}» بلا أي نقطة فرض في الكود — احذفها أو أضف حارسها.`);
    }
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
