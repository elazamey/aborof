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
 * كود الخروج: 0 = لا يوجد نقص حاجب، 1 = نقص حاجب (سر إلزامي غائب أو بوابة مغلقة).
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
  { name: "VERCEL_DEPLOY_ENABLED", level: "required", mustEqual: "true", why: "بوابة وظيفة النشر — أي قيمة غير true تُبقيها skipped" },
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

const allForbidden = [repoSecrets, repoVariables, envSecrets, envVariables].every((r) => !r.ok && r.forbidden);
if (allForbidden) {
  if (asJson) {
    console.log(JSON.stringify({ repo, environment: envName, error: "FORBIDDEN", status: 403, hint: "شغّله بحساب المالك" }, null, 2));
    process.exit(2);
  }
  console.error(
    [
      "❌ التوكن الحالي لا يملك صلاحية قراءة أسرار/متغيرات Actions (HTTP 403).",
      "",
      "هذا متوقع لأي GitHub App أو توكن روبوت — الصلاحية ملك لحساب المالك. نفّذ:",
      "  1) على جهازك:  gh auth status   (تأكد أنه حسابك الإداري، لا حساب بوت)",
      `  2) ثم:          node scripts/verify-deploy-secrets.mjs --repo ${repo} --env ${envName}`,
      "أو من الواجهة: Settings → Secrets and variables → Actions (انسخ الأسماء وقارنها بالجدول أدناه).",
      "",
      "الأسماء المطلوبة للمقارنة اليدوية:",
      `  أسرار إلزامية: ${SECRETS.filter((s) => s.level === "required").map((s) => s.name).join(", ")}`,
      `  متغيرات: ${VARIABLES.map((v) => v.name).join(", ")}`,
    ].join("\n")
  );
  process.exit(2);
}

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

const missingSecretNames = SECRETS.filter((s) => !secrets.has(s.name) && !ONE_OF.some((g) => g.names.includes(s.name)));
const blocking = [];

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

const report = {
  repo,
  environment: envName,
  scopesReadable: {
    repo: repoSecrets.ok || repoVariables.ok,
    environment: envSecrets.ok || envVariables.ok,
    environmentExists: envSecrets.ok || envVariables.ok,
  },
  missingSecretNames,
  blocking,
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(blocking.length ? 1 : 0);
}

function cell(present, extra = "") {
  return present ? `✅ ${extra}`.trim() : "❌ غائب";
}

console.log(`# فحص أسرار النشر — ${repo} (نطاق البيئة: ${envName})\n`);
console.log(`قراءة نطاق المستودع: ${report.scopesReadable.repo ? "✅" : "❌"}  |  قراءة نطاق البيئة: ${report.scopesReadable.environment ? "✅" : "❌"}\n`);

console.log("## الأسرار\n");
console.log("| السر | الأهمية | الحالة | النطاق | آخر تحديث |");
console.log("|---|---|---|---|---|");
for (const secret of SECRETS) {
  const found = secrets.get(secret.name);
  console.log(
    `| \`${secret.name}\` | ${secret.level === "required" ? "إلزامي" : "اختياري"} | ${cell(Boolean(found))} | ${found?.scope ?? "—"} | ${found ? String(found.updatedAt).slice(0, 10) : "—"} |`
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
  console.log(`| \`${variable.name}\` | ${variable.level === "required" ? "إلزامي" : "اختياري"} | ${cell(Boolean(found))}${gateNote} | ${value} | ${found?.scope ?? "—"} |`);
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
console.log("- وظيفة النشر مرتبطة بـ `environment: ${envName}`؛ إن لم تكن البيئة موجودة سيُنشئها GitHub عند أول تشغيل ولن تجد أسرارًا مقصورة عليها.");

console.log("\n## الخلاصة\n");
if (blocking.length === 0) {
  console.log("✅ لا يوجد نقص حاجب: كل الأسرار والمتغيرات الإلزامية حاضرة، وبوابة `VERCEL_DEPLOY_ENABLED` مفتوحة.");
} else {
  console.log("❌ نقص حاجب يجب إغلاقه قبل النشر:");
  for (const item of blocking) console.log(`  - ${item}`);
}

process.exit(blocking.length ? 1 : 0);
