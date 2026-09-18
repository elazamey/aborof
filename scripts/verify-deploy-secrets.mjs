#!/usr/bin/env node
/**
 * فحص أسرار ومتغيرات النشر مقابل جدول «النشر التلقائي» في DEPLOYMENT.md.
 *
 * ⚠️ لماذا يحتاج المالك: GitHub لا يسمح لأي GitHub App (وبالتالي توكن
 * الوكيل الآلي) بقراءة أسماء أسرار Actions ولا بالوصول إلى `gh secret list`؛
 * هذه الصلاحية ملك لحساب إداري/توكن بصلاحية Secrets. شغّل هذا الملف من
 * جهازك بحساب المالك:
 *
 *   node scripts/verify-deploy-secrets.mjs
 *   node scripts/verify-deploy-secrets.mjs --env production --json
 *
 * لا تُطبع أي قيمة سرية مطلقًا: الأسماء ونطاقها فقط (وتواريخ آخر تحديث)،
 * وقيم المتغيرات غير الحساسة (أعلام) حين تكون هي المقصودة بالفحص.
 *
 * حتى بلا صلاحية أسرار، تقرأ الأداة **حماية بيئة النشر** وحالة حماية `main`
 * (بيانات غير سرية) وترصد الفخ الصامت: سياسة «الفروع المحمية فقط» مع main
 * غير محمي ⇒ رفض النشر بقاعدة الحماية.
 *
 * كود الخروج: 0 = لا يوجد نقص حاجب، 1 = نقص حاجب (سر إلزامي غائب/بوابة مغلقة/
 * تعارض حماية بيئة)، 2 = تعذّرت القراءة (صلاحية مفقودة) أو استخدام خاطئ.
 */
import { execFileSync } from "node:child_process";

const USAGE = `الاستخدام: node scripts/verify-deploy-secrets.mjs [--repo owner/name] [--env production] [--json]`;

// ---------------------------------------------------------------------------
// قائمة المتطلبات — مصدرها جدول DEPLOYMENT.md (تُحدَّث معه في نفس الـ PR).
// level: required (حاجب) | optional (يُنبَّه فقط)
// ---------------------------------------------------------------------------
const SECRETS = [
  { name: "VERCEL_TOKEN", level: "required", why: "نشر Vercel من Actions (يُفحص داخل خطوة Verify required deployment secrets)" },
  { name: "VERCEL_ORG_ID", level: "required", why: "معرّف الفريق المستهدف للنشر" },
  { name: "VERCEL_PROJECT_ID", level: "required", why: "معرّف المشروع الإنتاجي المستهدف" },
  { name: "TURSO_DATABASE_URL", level: "required", why: "اتصال قاعدة الإنتاج (Actions + Vercel runtime)" },
  { name: "TURSO_AUTH_TOKEN", level: "required", why: "رمز قاعدة الإنتاج (Actions + Vercel runtime)" },
  { name: "ADMIN_PASSWORD", level: "required", why: "دخول لوحة الإدارة (Vercel runtime) — 12 حرفًا على الأقل" },
  { name: "ADMIN_SESSION_SECRET", level: "required", why: "توقيع الجلسات فقط (Vercel runtime) — 32 حرفًا على الأقل" },
  { name: "DIAGNOSTICS_KEY", level: "optional", why: "مفتاح مستقل تمامًا عن ADMIN_SESSION_SECRET — لتفعيل التشخيص فقط" },
  { name: "NVIDIA_NIM_API_KEY", level: "optional", why: "مزود NIM (المرحلة الثانية) — البديل المقبول: NVIDIA_API_KEY" },
];

const VARIABLES = [
  { name: "VERCEL_DEPLOY_ENABLED", level: "required", mustEqual: "true", why: "بوابة وظيفة النشر — يجب أن تكون Variable (لا Secret) وبالقيمة الحرفية true" },
  { name: "ENABLE_AI_AGENT", level: "optional", why: "توجيه /api/chat إلى محرك الوكيل" },
  { name: "AI_PROVIDER_ORDER", level: "optional", why: "ترتيب سلسلة المزودين" },
  { name: "NVIDIA_NIM_BASE_URL", level: "optional", why: "يجب أن يبدأ بـ https:// وإلا خرج المزود من السلسلة" },
  { name: "NVIDIA_NIM_MODEL", level: "optional", why: "اسم نموذج NIM" },
  { name: "ENABLE_MCP_TOOLS", level: "optional", why: "طبقة MCP المحكومة" },
  { name: "MCP_ALLOWED_TOOLS", level: "optional", why: "قائمة أدوات مسموحة (الافتراضي: قراءة فقط)" },
  { name: "MCP_ALLOW_WRITE_TOOLS", level: "optional", why: "بوابة مستقلة للأدوات الكاتبة — مغلقة افتراضيًا" },
  { name: "MCP_MAX_CALLS_PER_REQUEST", level: "optional", why: "0–8" },
  { name: "MCP_TOOL_TIMEOUT_MS", level: "optional", why: "300–10000" },
  { name: "MCP_MAX_RESULT_CHARS", level: "optional", why: "200–20000" },
  { name: "DIAGNOSTICS_ENABLED", level: "optional", why: "تشخيص (معطّل في الإنتاج افتراضيًا)" },
  { name: "CSP_ENFORCE", level: "optional", why: "true = تشديد CSP من المراقبة إلى الحجب" },
  { name: "ENABLE_ORDER_TRACKING", level: "optional", why: "الخطوة 5 — لا يُفتح إلا بعد اجتياز الصفين 13 و14" },
];

/** مجموعات «واحد على الأقل» (one-of). */
const ONE_OF = [
  { group: "مزود الدردشة (GEMINI_API_KEY أو GROQ_API_KEY)", names: ["GEMINI_API_KEY", "GROQ_API_KEY"], level: "optional" },
  { group: "مزود NIM (NVIDIA_NIM_API_KEY أو NVIDIA_API_KEY)", names: ["NVIDIA_NIM_API_KEY", "NVIDIA_API_KEY"], level: "optional" },
];

/** المتغيرات التي تُطبع قيمها لأنها أعلام غير حساسة بطبيعتها (موثّقة في DEPLOYMENT.md). */
const PRINTABLE_VARIABLE_VALUES = new Set([
  "VERCEL_DEPLOY_ENABLED",
  "ENABLE_ORDER_TRACKING",
  "ENABLE_AI_AGENT",
  "ENABLE_MCP_TOOLS",
  "MCP_ALLOW_WRITE_TOOLS",
  "DIAGNOSTICS_ENABLED",
  "CSP_ENFORCE",
]);

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}

function arg(name, fallback = null) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const asJson = args.includes("--json");
const envName = arg("--env", "production");

function gh(endpoint) {
  try {
    const out = execFileSync("gh", ["api", endpoint], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, data: JSON.parse(out) };
  } catch (error) {
    const stderr = String(error?.stderr ?? error?.message ?? "");
    return { ok: false, forbidden: /403|Resource not accessible by integration/.test(stderr), stderr };
  }
}

function resolveRepo() {
  const explicit = arg("--repo");
  if (explicit) return explicit;
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  try {
    return execFileSync("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

const repo = resolveRepo();
if (!repo) {
  console.error("تعذر تحديد المستودع. مرّر --repo owner/name أو شغّل من داخل مستودع مرتبط بـ gh.");
  process.exit(2);
}

const repoSecrets = gh(`/repos/${repo}/actions/secrets?per_page=100`);
const repoVariables = gh(`/repos/${repo}/actions/variables?per_page=100`);
const envSecrets = gh(`/repos/${repo}/environments/${envName}/secrets?per_page=100`);
const envVariables = gh(`/repos/${repo}/environments/${envName}/variables?per_page=100`);
// معلومات البيئة ونظام حماية الفرع: تُقرأ بصلاحية عادية (بلا صلاحية أسرار) لأنها ليست سرية.
const environment = gh(`/repos/${repo}/environments/${envName}`);
const mainBranch = gh(`/repos/${repo}/branches/main`);

const secrets = new Map();
const variables = new Map();
for (const entry of repoSecrets.ok ? repoSecrets.data.secrets ?? [] : []) {
  secrets.set(entry.name, { scope: "repo", updatedAt: entry.updated_at });
}
for (const entry of envSecrets.ok ? envSecrets.data.secrets ?? [] : []) {
  secrets.set(entry.name, { scope: `environment:${envName}`, updatedAt: entry.updated_at });
}
for (const entry of repoVariables.ok ? repoVariables.data.variables ?? [] : []) {
  variables.set(entry.name, { scope: "repo", value: entry.value, updatedAt: entry.updated_at });
}
for (const entry of envVariables.ok ? envVariables.data.variables ?? [] : []) {
  // متغيرات البيئة تتقدّم على متغير المستودع عند تعارض الاسم (نفس سلوك GitHub في الوظائف المرتبطة ببيئة).
  variables.set(entry.name, { scope: `environment:${envName}`, value: entry.value, updatedAt: entry.updated_at });
}

const envInfo = environment.ok ? environment.data : null;
const mainProtected = mainBranch.ok ? Boolean(mainBranch.data.protected) : null;
const branchPolicy = envInfo?.deployment_branch_policy ?? null;
const protectionTypes = (envInfo?.protection_rules ?? []).map((rule) => rule.type);
const environmentWarnings = [];
const blocking = [];

if (envInfo && protectionTypes.includes("required_reviewers")) {
  environmentWarnings.push(`بيئة «${envInfo.name}» تتطلب مراجعين: كل نشر سينتظر اعتمادًا يدويًا (سلوك مقصود إن أردته).`);
}
if (envInfo && protectionTypes.includes("wait_timer")) {
  environmentWarnings.push(`بيئة «${envInfo.name}» عليها مدة انتظار: النشر يتأخر قبل البدء.`);
}

// الفخ الصامت: سياسة «الفروع المحمية فقط» مع main غير محمي ⇒ رفض وظيفة النشر
// بقاعدة الحماية قبل أي خطوة، وهي حالة لا تُرى في أي سجل أسرار.
if (envInfo && branchPolicy?.protected_branches === true && mainProtected === false) {
  blocking.push(
    `بيئة النشر «${envInfo.name}» تقصر النشر على الفروع المحمية و main غير محمي ⇒ ستُرفض وظيفة النشر بقاعدة الحماية. ` +
      `الحل: Settings → Environments → ${envInfo.name} → Deployment branches → All branches (أو Allow custom branches + main).`
  );
}

if (!mainProtected && envInfo && !branchPolicy) {
  environmentWarnings.push("main غير محمي: يُنصح بإضافة حماية فرع + required checks قبل تفعيل النشر التلقائي المستمر (يتطلب خطة مدفوعة للمستودعات الخاصة).");
}

const allForbidden = [repoSecrets, repoVariables, envSecrets, envVariables].every((r) => !r.ok && r.forbidden);

const missingSecretNames = SECRETS.filter((s) => !secrets.has(s.name) && !ONE_OF.some((g) => g.names.includes(s.name)));

if (!allForbidden) {
  for (const secret of SECRETS) {
    if (!secrets.has(secret.name) && secret.level === "required") blocking.push(`سر إلزامي غائب: ${secret.name}`);
  }
  for (const variable of VARIABLES) {
    const found = variables.get(variable.name);
    if (variable.level === "required" && !found) blocking.push(`متغير إلزامي غائب: ${variable.name}`);
    if (found && variable.mustEqual !== undefined && String(found.value) !== variable.mustEqual) {
      blocking.push(`بوابة مغلقة: ${variable.name} = ${JSON.stringify(found.value)} (المطلوب ${JSON.stringify(variable.mustEqual)})`);
    }
  }
  // بوابة النشر يجب أن تكون Variable لا Secret: الشروط تقرأ `vars`، والقيمة في
  // تبويب Secrets لا تظهر هناك أبدًا (سبب شائع لتخطي النشر بلا أي رسالة).
  if (secrets.has("VERCEL_DEPLOY_ENABLED")) {
    blocking.push(
      "VERCEL_DEPLOY_ENABLED موضوع في تبويب Secrets — يجب أن يكون Variable؛ الشروط تقرأ `vars` فقط، فالقيمة كسرّ تبقى غير مرئية."
    );
  }
}

const report = {
  repo,
  environment: envName,
  environmentResolvedName: envInfo?.name ?? null,
  environmentExists: Boolean(envInfo),
  environmentProtectionRules: protectionTypes,
  deploymentBranchPolicy: branchPolicy,
  mainProtected,
  scopesReadable: {
    repo: repoSecrets.ok || repoVariables.ok,
    environment: envSecrets.ok || envVariables.ok,
  },
  environmentWarnings,
  missingSecretNames,
  blocking,
};

function printEnvironmentSection() {
  console.log("## بيئة النشر (بيانات غير سرية)\n");
  if (envInfo) {
    console.log(`- الاسم الفعلي على GitHub: \`${envInfo.name}\` (الأسماء غير حساسة لحالة الأحرف، فـ \`${envName}\` يحل إليها).`);
    console.log(`- قواعد الحماية: ${protectionTypes.length ? protectionTypes.map((t) => `\`${t}\``).join(", ") : "لا شيء"}`);
    const policyLabel = !branchPolicy
      ? "لا سياسة فروع (كل الفروع مسموحة)"
      : branchPolicy.protected_branches
        ? "الفروع المحمية فقط ⚠️"
        : "فروع مخصّصة مفعّلة";
    console.log(`- سياسة فروع النشر: ${policyLabel}`);
    console.log(`- \`main\` محمي؟ ${mainProtected === null ? "تعذّرت القراءة" : mainProtected ? "✅ نعم" : "❌ لا"}`);
  } else {
    console.log(`- ⚠️ تعذّرت قراءة البيئة \`${envName}\` (قد لا تكون منشأة بعد؛ تُنشأ تلقائيًا عند أول وظيفة تشير إليها وتكون بلا أسرار حينها).`);
  }
  if (environmentWarnings.length) {
    console.log("");
    for (const item of environmentWarnings) console.log(`- ⚠️ ${item}`);
  }
}

const manualNames = [
  "الأسماء المطلوبة للمقارنة اليدوية (Settings → Secrets and variables → Actions):",
  `  أسرار إلزامية: ${SECRETS.filter((s) => s.level === "required").map((s) => s.name).join(", ")}`,
  `  أسرار اختيارية: ${SECRETS.filter((s) => s.level === "optional").map((s) => s.name).join(", ")}`,
  `  متغيرات (Variables لا Secrets): ${VARIABLES.map((v) => v.name).join(", ")}`,
].join("\n");

if (allForbidden) {
  if (asJson) {
    console.log(JSON.stringify({ ...report, error: "FORBIDDEN", status: 403, hint: "شغّله بحساب المالك لقراءة الأسرار" }, null, 2));
    process.exit(2);
  }
  console.log(`# فحص أسرار النشر — ${repo} (نطاق البيئة: ${envName})\n`);
  console.error(
    [
      "❌ التوكن الحالي لا يملك صلاحية قراءة أسرار/متغيرات Actions (HTTP 403) — سلوك GitHub المقصود لأي GitHub App.",
      "نفّذ على جهازك بحساب المالك:",
      `  node scripts/verify-deploy-secrets.mjs --repo ${repo} --env ${envName}`,
      "لكن الفحوص غير السرية تعمل هنا بالفعل:",
      "",
    ].join("\n")
  );
  printEnvironmentSection();
  console.log(`\n${manualNames}\n`);
  if (blocking.length) {
    console.log("❌ نقص حاجب مكتشف بلا صلاحية أسرار:");
    for (const item of blocking) console.log(`  - ${item}`);
  }
  process.exit(blocking.length ? 1 : 2);
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(blocking.length ? 1 : 0);
}

console.log(`# فحص أسرار النشر — ${repo} (نطاق البيئة: ${envName})\n`);
console.log(`قراءة نطاق المستودع: ${report.scopesReadable.repo ? "✅" : "❌"}  |  قراءة نطاق البيئة: ${report.scopesReadable.environment ? "✅" : "❌"}\n`);

printEnvironmentSection();

console.log("\n## الأسرار\n");
console.log("| السر | الأهمية | الحالة | النطاق | آخر تحديث |");
console.log("|---|---|---|---|---|");
for (const secret of SECRETS) {
  const found = secrets.get(secret.name);
  console.log(
    `| \`${secret.name}\` | ${secret.level === "required" ? "إلزامي" : "اختياري"} | ${found ? "✅" : "❌ غائب"} | ${found?.scope ?? "—"} | ${found ? String(found.updatedAt).slice(0, 10) : "—"} |`
  );
}

console.log("\n## المتغيرات\n");
console.log("| المتغير | الأهمية | الحالة | القيمة | النطاق |");
console.log("|---|---|---|---|---|");
for (const variable of VARIABLES) {
  const found = variables.get(variable.name);
  const value = found
    ? PRINTABLE_VARIABLE_VALUES.has(variable.name)
      ? `\`${String(found.value)}\``
      : "(قيمة غير مطبوعة)"
    : "—";
  const gateNote =
    found && variable.mustEqual !== undefined
      ? String(found.value) === variable.mustEqual
        ? " ✅"
        : " ❌ (بوابة مغلقة)"
      : "";
  console.log(`| \`${variable.name}\` | ${variable.level === "required" ? "إلزامي" : "اختياري"} | ${found ? "✅" : "❌ غائب"}${gateNote} | ${value} | ${found?.scope ?? "—"} |`);
}

console.log("\n## مجموعات «واحد على الأقل»\n");
for (const group of ONE_OF) {
  const present = group.names.filter((n) => secrets.has(n));
  const icon = present.length ? "✅" : "⚠️";
  console.log(`- ${icon} ${group.group}: ${present.length ? present.map((n) => `\`${n}\``).join(", ") : "لا شيء (المزود غير متاح — سلوك مقصود لا يكسر السلسلة)"}`);
}

console.log("\n## تنبيهات واجبة المراجعة اليدوية\n");
console.log("- أسرار Actions لا تنتقل تلقائيًا إلى Runtime في Vercel: تأكد من وجود `TURSO_DATABASE_URL` و`TURSO_AUTH_TOKEN` و`ADMIN_PASSWORD` و`ADMIN_SESSION_SECRET` في Vercel Project → Settings → Environment Variables (Production).");
console.log("- تأكد أن `ADMIN_SESSION_SECRET` يختلف عن `DIAGNOSTICS_KEY` (القيم غير قابلة للقراءة من GitHub، والفحص إلزامي قبل النشر).");
console.log("- وظيفة النشر مرتبطة بـ `environment: production`؛ الأسماء غير حساسة لحالة الأحرف، وتقرأ الوظيفة نطاق البيئة ثم نطاق المستودع.");
console.log("- `VERCEL_DEPLOY_ENABLED` يُقرأ داخل خطوة (وظيفة Deploy gate) لأن GitHub لا يوفر متغيرات البيئة في شروط `if` على مستوى الوظيفة.");

console.log("\n## الخلاصة\n");
if (blocking.length === 0) {
  console.log("✅ لا يوجد نقص حاجب: كل الأسرار والمتغيرات الإلزامية حاضرة، وبوابة `VERCEL_DEPLOY_ENABLED` مفتوحة، وحماية البيئة لا تمنع النشر.");
} else {
  console.log("❌ نقص حاجب يجب إغلاقه قبل النشر:");
  for (const item of blocking) console.log(`  - ${item}`);
}

process.exit(blocking.length ? 1 : 0);
