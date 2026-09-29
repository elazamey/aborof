#!/usr/bin/env node
/**
 * الطيران التمهيدي لهوية Vercel — يُشغَّل داخل `deploy.yml` قبل `npm ci`.
 *
 * لماذا ملف Node بدل خطوات bash+jq:
 *   1. **بلا اعتماديات** (fetch مدمج في Node 20) فيعمل قبل تثبيت الحزم.
 *   2. التشخيص **مُصنَّف ومختبَر**: scripts/lib/vercel-link.mjs يحوّل
 *      `404 Project not found` إلى واحد من ستة أحكام بأسباب وإجراءات، بدل
 *      رسالة واحدة غامضة أوقفت ثلاثة نشرات متتالية.
 *   3. نفس المنطق يُستخدم من جهاز المالك (scripts/apply-vercel-link.mjs) فلا
 *      يتفرّق التشخيص بين CI والمحلي.
 *
 * ما يفحصه (للقراءة فقط — لا نشر ولا كتابة):
 *   1. `GET /v2/user`                              → هوية الرمز وصلاحيته.
 *   2. `GET /v9/projects/$PROJECT_ID?teamId=$ORG`  → هل يحلّ المعرّفان معًا؟
 *   3. تطابق اسم المشروع مع `VERCEL_EXPECTED_PROJECT` (افتراضيًا `aborof`)
 *      → يمنع «نشر ناجح في Actions والإنتاج لم يتغير» (المستودع مرتبط بثلاثة
 *      مشاريع Vercel، وتكامل Git ينشرها كلها).
 *   4. عند الفشل: `GET /v9/projects` في النطاقين (بـ teamId وبلا teamId)
 *      لطباعة **أسماء** المشاريع التي يراها الرمز — وهي المعلومة الوحيدة التي
 *      تحسم أي سبب من الأربعة هو العطل.
 *
 * سياسة العرض (نفس نصّ deploy.yml): الأسماء فقط. لا تُطبع قيمة معرّف ولا رمز؛
 * الأشكال المقنّعة والأطوال فقط، لأن سجلات CI يقرؤها أي قارئ للمستودع ولأن
 * المعرّف **الصحيح** ليس سرًّا مسجّلًا في GitHub فلا يُحجب تلقائيًا.
 *
 * كود الخروج: 0 = الهوية سليمة والمطلوب مطابق · 1 = فشل حاجب (رمز/نطاق/معرّف/
 * اسم مشروع) · 2 = تهيئة ناقصة (سرّ غائب أو قاعدة API مرفوضة).
 *
 * الاستخدام:
 *   node scripts/vercel-preflight.mjs                # في CI (يقرأ متغيرات البيئة)
 *   node scripts/vercel-preflight.mjs --json         # تقرير آلي (للاختبارات)
 *   node scripts/vercel-preflight.mjs --expected aborof-store-v2
 */
import {
  DEFAULT_EXPECTED_PROJECT,
  DEFAULT_VERCEL_API_BASE,
  DEPLOY_SECRET_NAMES,
  diagnoseProjectLookup,
  expectedProjectMatches,
  maskIdentifier,
  renderDiagnosis,
  renderVisibleProjects,
  resolveApiBase,
} from "./lib/vercel-link.mjs";

const USAGE = `الاستخدام: node scripts/vercel-preflight.mjs [--expected <اسم المشروع>] [--json]`;

const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) {
  console.log(USAGE);
  process.exit(0);
}
const asJson = args.includes("--json");

function arg(name, fallback = null) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
for (const flag of args) {
  if (flag.startsWith("-") && !["--json", "--expected"].includes(flag)) {
    console.error(`خيار غير معروف: ${flag}\n${USAGE}`);
    process.exit(2);
  }
}

const env = process.env;
const expectedName = String(arg("--expected", env.VERCEL_EXPECTED_PROJECT || DEFAULT_EXPECTED_PROJECT)).trim();
const token = String(env.VERCEL_TOKEN ?? "");
const orgId = String(env.VERCEL_ORG_ID ?? "");
const projectId = String(env.VERCEL_PROJECT_ID ?? "");

/* هروب أحرف أوامر GitHub: التعليق سطر واحد دائمًا، وإلا انكسر السجل. */
function annotation(level, message) {
  const escaped = String(message)
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A");
  console.log(`::${level}::${escaped}`);
}

const report = {
  tool: "vercel-preflight",
  apiBase: env.VERCEL_API_BASE || DEFAULT_VERCEL_API_BASE,
  expectedProject: expectedName,
  missingSecrets: DEPLOY_SECRET_NAMES.filter((name) => !String(env[name] ?? "").trim()),
  tokenAccount: null,
  orgScope: null,
  projectIdMasked: maskIdentifier(projectId),
  projectName: null,
  projectFramework: null,
  diagnosis: null,
  visibleProjects: null,
  ok: false,
};

/** نداء واحد: الرمز في الرأس (لا في argv ولا في الرابط) والمهلة صريحة. */
async function api(path, { query } = {}) {
  const baseCheck = resolveApiBase(env.VERCEL_API_BASE, {
    allowInsecure: String(env.VERCEL_API_ALLOW_INSECURE_BASE ?? "").toLowerCase() === "true",
  });
  if (!baseCheck.ok) return { ok: false, status: 0, json: null, error: new Error(baseCheck.error), baseRejected: true };
  const url = new URL(path, `${baseCheck.base}/`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    }
  }
  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "aborof/vercel-preflight",
      },
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { ok: response.ok, status: response.status, json, text };
  } catch (error) {
    return { ok: false, status: 0, json: null, text: "", error };
  }
}

function errorMessage(res) {
  return String(res?.json?.error?.message ?? res?.json?.error?.code ?? res?.error?.message ?? "لا يوجد جسم استجابة").slice(0, 300);
}

function finish(code) {
  if (asJson) console.log(JSON.stringify(report, null, 2));
  process.exit(code);
}

async function main() {
  // 0) التهيئة: سرّ غائب = لا معنى لأي نداء.
  if (report.missingSecrets.length) {
    for (const name of report.missingSecrets) {
      annotation("error", `سرّ ناقص: ${name} — أضفه في Settings → Secrets and variables → Actions (نطاق المستودع أو بيئة production).`);
    }
    finish(2);
  }
  const baseCheck = resolveApiBase(env.VERCEL_API_BASE, {
    allowInsecure: String(env.VERCEL_API_ALLOW_INSECURE_BASE ?? "").toLowerCase() === "true",
  });
  if (!baseCheck.ok) {
    annotation("error", baseCheck.error);
    finish(2);
  }
  if (baseCheck.insecure) annotation("warning", `قاعدة API محلية غير آمنة مقبولة للاختبارات فقط: ${baseCheck.base}`);

  // 1) هوية الرمز.
  const userRes = await api("v2/user");
  if (!userRes.ok) {
    annotation(
      "error",
      `فحص رمز Vercel فشل — HTTP ${userRes.status}: ${errorMessage(userRes)}${
        userRes.status === 404 ? " (رمز مصادَق عليه لكنه ملغى/غير موجود — استبدله)" : ""
      }`
    );
    annotation("error", "الإجراء: أنشئ رمزًا جديدًا في Vercel → Account Settings → Tokens بصلاحية Full access على الفريق، ثم حدّث سرّ VERCEL_TOKEN.");
    report.diagnosis = { code: "TOKEN_REJECTED", headline: `HTTP ${userRes.status}` };
    finish(1);
  }
  const user = userRes.json?.user ?? userRes.json ?? {};
  // ‏username فقط؛ وإن غاب فشكل مقنّع للـ uid — لأن uid في الحساب الشخصي هو نفسه
  // قيمة ORG_ID الصحيحة (سرّ يُضبط)، وسياسة هذه الخطوة «الأسماء فقط».
  report.tokenAccount = user.username ? String(user.username) : maskIdentifier(String(user.uid ?? ""));
  annotation("notice", `Vercel token صالح — الحساب: ${report.tokenAccount}`);

  // 2) هل يحلّ زوج (projectId, orgId) معًا؟
  const projectRes = await api(`v9/projects/${encodeURIComponent(projectId)}`, { query: { teamId: orgId } });

  if (projectRes.ok) {
    report.projectName = String(projectRes.json?.name ?? "") || null;
    report.projectFramework = String(projectRes.json?.framework ?? "") || null;
    annotation(
      "notice",
      `مشروع Vercel متاح — الاسم: ${report.projectName ?? "?"} (إطار: ${report.projectFramework ?? "?"}) — تأكد أنه المشروع الذي يخدم aborof.vercel.app`
    );
  }

  // 3) تُجمع المشاريع المرئية في النطاقين عند الفشل **أو** عند اختلاف الاسم:
  //    القائمة هي ما يحوّل «المعرّف يحل إلى مشروع آخر» من ادعاء إلى دليل.
  const needScopeProbe = !projectRes.ok || !expectedProjectMatches(report.projectName, expectedName);
  if (needScopeProbe) {
    const [teamScope, personalScope] = await Promise.all([
      orgId ? api("v9/projects", { query: { limit: 100, teamId: orgId } }) : Promise.resolve({ ok: false, status: 0, json: null }),
      api("v9/projects", { query: { limit: 100 } }),
    ]);
    report.visibleProjects = {
      teamScope: { status: teamScope.status, names: listNames(teamScope) },
      personalScope: { status: personalScope.status, names: listNames(personalScope) },
      note: "أسماء فقط — لا معرّفات (سياسة deploy.yml)",
    };
  }

  const diagnosis = diagnoseProjectLookup({
    status: projectRes.status,
    projectName: report.projectName,
    expectedName,
    orgId,
    user,
    teamScope: report.visibleProjects?.teamScope ?? undefined,
    personalScope: report.visibleProjects?.personalScope ?? undefined,
    error: projectRes.error ?? null,
  });
  report.diagnosis = { code: diagnosis.code, headline: diagnosis.headline, causes: diagnosis.causes, fixes: diagnosis.fixes };
  report.orgScope = diagnosis.scopeDescribe;

  if (diagnosis.code === "PROJECT_OK") {
    annotation("notice", `تطابق الاسم المتوقع: المشروع المنشور هو «${expectedName}» فعلًا — لا خطر «نشر ناجح وإنتاج لم يتغير».`);
    report.ok = true;
    finish(0);
  }

  // 4) الفشل الحاجب: حكم مُصنَّف + أسماء المشاريع المرئية (التعليقات هي القناة
  //    الوحيدة المقروءة آليًا حين يُحجب تنزيل السجلات عن بعض الشبكات).
  const lines = renderDiagnosis(diagnosis);
  annotation("error", lines[0]);
  if (diagnosis.causes?.length) annotation("error", `الأسباب: ${diagnosis.causes.join(" | ")}`);
  if (diagnosis.fixes?.length) annotation("error", `الإجراءات: ${diagnosis.fixes.join(" | ")}`);
  annotation("notice", `نطاق VERCEL_ORG_ID كما يراه الرمز: ${diagnosis.scopeDescribe} · VERCEL_PROJECT_ID: ${maskIdentifier(projectId)}`);
  if (needScopeProbe) {
    annotation("notice", `المشاريع المرئية لهذا الرمز (أسماء فقط): ${visibleFlat(diagnosis).join("، ") || "لا شيء"}`);
  }

  // نسخة مقروءة في السجل نفسه (لا في التعليقات فقط).
  if (!asJson) {
    console.log("");
    console.log("# Vercel preflight — تشخيص هوية المشروع");
    console.log(`- حساب الرمز: ${report.tokenAccount}`);
    console.log(`- نطاق ORG_ID: ${diagnosis.scopeDescribe}`);
    console.log(`- PROJECT_ID: ${maskIdentifier(projectId)}`);
    console.log(`- الاسم المتوقع: ${expectedName}`);
    for (const line of lines) console.log(line);
    if (needScopeProbe) for (const line of renderVisibleProjects(diagnosis, expectedName)) console.log(line);
  }
  finish(1);
}

function listNames(res) {
  const list = Array.isArray(res?.json?.projects) ? res.json.projects : [];
  return list.map((p) => String(p?.name ?? "")).filter(Boolean);
}
function visibleFlat(diagnosis) {
  const names = [...(diagnosis.names?.team ?? []), ...(diagnosis.names?.personal ?? [])];
  return [...new Set(names)];
}

main().catch((error) => {
  annotation("error", `استثناء غير متوقع في الطيران التمهيدي: ${String(error?.message ?? error).slice(0, 300)}`);
  if (asJson) console.log(JSON.stringify({ ...report, ok: false, fatal: String(error?.message ?? error) }, null, 2));
  process.exit(1);
});
