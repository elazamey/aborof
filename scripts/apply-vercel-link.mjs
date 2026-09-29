#!/usr/bin/env node
/**
 * ربط مشروع Vercel وضبط أسرار النشر على GitHub — من جهاز المالك، بأمر واحد.
 *
 * يحلّ محل التسلسل اليدوي المعتاد:
 *     npx vercel link && cat .vercel/project.json
 *     gh secret set VERCEL_PROJECT_ID --body "prj_YOUR_PROJECT_ID"
 *     gh secret set VERCEL_ORG_ID     --body "team_YOUR_TEAM_ID"
 *     gh secret set VERCEL_TOKEN      --body "YOUR_VERCEL_TOKEN"
 *     gh workflow run deploy.yml --ref main
 *
 * ولماذا لا يصحّ تنفيذه حرفيًا:
 *   1. القيم في الأوامر الجاهزة **موضعية**؛ `gh secret set` «ينجح» ويكتب
 *      `YOUR_VERCEL_TOKEN` فوق رمز كان يعمل ⇒ نشر مكسور بصمت.
 *   2. `team_YOUR_TEAM_ID` تفترض نطاق فريق؛ الرمز الشخصي (Hobby) يحتاج
 *      `orgId` = معرّف الحساب **بلا** بادئة `team_` — والخطأ يظهر كـ
 *      `404 Project not found` لا كخطأ نطاق.
 *   3. المستودع مرتبط بثلاثة مشاريع Vercel، فنسخ معرّف المشروع الخطأ يجعل
 *      Actions أخضر بينما الإنتاج لم يتغير.
 *   4. `gh secret set` يحتاج صلاحية أسرار؛ أي GitHub App (ومنه توكن الوكيل
 *      الآلي) يُردّ بـ 403 — تُفحص الصلاحية **قبل** أي محاولة لا بعدها.
 *
 * مبادئ أمنية غير قابلة للتفاوض (نفسها في scripts/apply-turso-secrets.sh):
 *   - لا تُطبع أي قيمة سرية أبدًا؛ المعروض الاسم والشكل المقنّع والطول.
 *   - لا تُمرَّر القيم كوسائط سطر أوامر (تظهر في `ps`)؛ عبر stdin أو بيئة الطفل.
 *   - التحقق الحيّ قبل أي لمس: إن لم يحلّ الزوج (projectId, orgId) إلى المشروع
 *     المطلوب يتوقف بلا كتابة أي سرّ. التخطي المتعمد الوحيد: `--skip-verify`.
 *
 * ما يفعله:
 *   أ) يفحص الرمز (`GET /v2/user`) ويرفض القيم الموضعية ورموز المنصات الأخرى.
 *   ب) يحلّ المعرّفين من أول مصدر ينجح: الأعلام ← `.vercel/project.json` ←
 *      `vercel link` ← **البحث بالاسم في قائمة مشاريع الرمز** (يصلح حتى بلا CLI).
 *   ج) يتحقق أن الزوج يحل إلى المشروع المتوقع (`aborof` افتراضيًا).
 *   د) يفحص صلاحية كتابة الأسرار على GitHub ثم يضبطها عبر stdin.
 *   هـ) ينبّه إن كانت بوابة `VERCEL_DEPLOY_ENABLED` مغلقة (السبب الصامت لتخطي النشر).
 *   و) اختياريًا (`--dispatch`) يشغّل deploy.yml على main ويتابعه حتى النهاية.
 *
 * كود الخروج: 0 = ضُبطت الأسرار (أو معاينة جافة نجحت) · 1 = فشل حاجب (رمز/معرّفات/
 * اسم مشروع/بوابة) · 2 = تهيئة أو صلاحية ناقصة (بلا gh، بلا tty، 403 على الأسرار).
 *
 * الاستخدام:
 *   node scripts/apply-vercel-link.mjs                      # يطلب الرمز مخفيًا ثم يربط ويضبط
 *   node scripts/apply-vercel-link.mjs --dry-run            # كل الفحوص، بلا كتابة أي سرّ
 *   VERCEL_TOKEN=… node scripts/apply-vercel-link.mjs --dispatch
 *   node scripts/apply-vercel-link.mjs --project aborof --env production
 *   node scripts/apply-vercel-link.mjs --project-id prj_… --org-id …   # تجاوز الربط
 *   node scripts/apply-vercel-link.mjs --skip-link          # اقرأ .vercel/project.json الموجود
 *   node scripts/apply-vercel-link.mjs --json
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_EXPECTED_PROJECT,
  DEFAULT_VERCEL_API_BASE,
  DEPLOY_SECRET_NAMES,
  diagnoseProjectLookup,
  findProjectByName,
  isPlaceholderValue,
  isUsableProjectLink,
  maskIdentifier,
  projectNames,
  renderDiagnosis,
  renderVisibleProjects,
  resolveApiBase,
  validateTokenShape,
} from "./lib/vercel-link.mjs";

const USAGE = `الاستخدام: node scripts/apply-vercel-link.mjs [--project <اسم>] [--expected <اسم>]
       [--project-id prj_…] [--org-id <id>] [--repo owner/name] [--env production]
       [--token-file <path>] [--skip-link] [--skip-verify] [--dispatch] [--no-watch]
       [--dry-run] [--json]`;

const args = process.argv.slice(2);
const KNOWN_FLAGS = new Set([
  "--project", "--expected", "--project-id", "--org-id", "--repo", "--env", "--token-file",
  "--skip-link", "--skip-verify", "--dispatch", "--no-watch", "--dry-run", "--json", "-h", "--help",
]);
if (args.includes("-h") || args.includes("--help")) {
  console.log(USAGE);
  process.exit(0);
}
for (const flag of args) {
  if (flag.startsWith("-") && !KNOWN_FLAGS.has(flag)) {
    console.error(`خيار غير معروف: ${flag}\n${USAGE}`);
    process.exit(2);
  }
}
function arg(name, fallback = null) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const has = (name) => args.includes(name);

const asJson = has("--json");
const dryRun = has("--dry-run");
const skipLink = has("--skip-link");
const skipVerify = has("--skip-verify");
const dispatch = has("--dispatch");
const watch = dispatch && !has("--no-watch");
const projectName = String(arg("--project", process.env.VERCEL_PROJECT_NAME || DEFAULT_EXPECTED_PROJECT)).trim();
const expectedName = String(arg("--expected", projectName)).trim();
const envName = arg("--env", null); // ‏null ⇒ نطاق المستودع (يعمل دائمًا؛ راجع runbook)
const explicitProjectId = arg("--project-id", null);
const explicitOrgId = arg("--org-id", null);
const tokenFile = arg("--token-file", null);

const report = {
  tool: "apply-vercel-link",
  apiBase: process.env.VERCEL_API_BASE || DEFAULT_VERCEL_API_BASE,
  expectedProject: expectedName,
  secretScope: envName ? `environment:${envName}` : "repo",
  dryRun,
  skipVerify,
  dispatch,
  tokenAccount: null,
  chosenSource: null,
  link: null,
  diagnosis: null,
  secretsWritten: [],
  gate: null,
  dispatchedRun: null,
  ok: false,
};

function out(...lines) {
  if (!asJson) for (const line of lines) console.log(line);
}
function fail(message, code = 1) {
  if (asJson) console.log(JSON.stringify({ ...report, ok: false, error: message }, null, 2));
  else console.error(`❌ ${message}`);
  process.exit(code);
}
function finish(code) {
  if (asJson) console.log(JSON.stringify(report, null, 2));
  process.exit(code);
}

/* ------------------------------------------------------------------ */
/* أوامر فرعية: gh و vercel — القيم عبر stdin أو بيئة الطفل، لا argv    */
/* ------------------------------------------------------------------ */

function gh(args_, { input } = {}) {
  try {
    const stdout = execFileSync("gh", args_, {
      encoding: "utf8",
      input,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    return { ok: true, stdout, stderr: "" };
  } catch (error) {
    const stderr = String(error?.stderr ?? error?.message ?? "");
    return { ok: false, stdout: String(error?.stdout ?? ""), stderr, forbidden: /403|Resource not accessible by integration/.test(stderr) };
  }
}

function ghApi(endpoint) {
  const res = gh(["api", endpoint]);
  if (!res.ok) return { ok: false, forbidden: res.forbidden, stderr: res.stderr, data: null };
  try {
    return { ok: true, data: JSON.parse(res.stdout), forbidden: false, stderr: "" };
  } catch {
    return { ok: false, forbidden: false, stderr: "استجابة غير JSON من gh api", data: null };
  }
}

function resolveRepo() {
  const explicit = arg("--repo");
  if (explicit) return explicit;
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  const res = gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
  return res.ok ? res.stdout.trim() : null;
}

/* ------------------------------------------------------------------ */
/* الرمز: من البيئة ← ملف ← stdin ← إدخال مخفي عبر /dev/tty             */
/* ------------------------------------------------------------------ */

function readTokenMuted(prompt) {
  const res = spawnSync(
    "bash",
    ["-c", `read -rs -p "$0" v </dev/tty && printf '%s' "$v"`, prompt],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }
  );
  if (res.status !== 0) return null;
  process.stderr.write("\n");
  return String(res.stdout ?? "");
}

function acquireToken() {
  const fromEnv = String(process.env.VERCEL_TOKEN ?? "");
  if (fromEnv.trim()) return { value: fromEnv.trim(), source: "متغير البيئة VERCEL_TOKEN" };
  if (tokenFile) {
    if (!fs.existsSync(tokenFile)) fail(`ملف الرمز غير موجود: ${tokenFile}`, 2);
    return { value: fs.readFileSync(tokenFile, "utf8").trim(), source: `--token-file ${tokenFile}` };
  }
  if (!process.stdin.isTTY) {
    try {
      const piped = fs.readFileSync(0, "utf8").trim();
      if (piped) return { value: piped, source: "stdin" };
    } catch {
      /* لا مدخل متاح — نُكمل إلى الإدخال المخفي */
    }
  }
  const typed = readTokenMuted("أدخل VERCEL_TOKEN (لن يظهر على الشاشة): ");
  if (typed && typed.trim()) return { value: typed.trim(), source: "إدخال مخفي من /dev/tty" };
  fail(
    "تعذّر الحصول على الرمز: مرّره بـ VERCEL_TOKEN=… أو --token-file <path> أو عبر stdin، " +
      "أو شغّله من طرفية حقيقية للإدخال المخفي.",
    2
  );
  return null;
}

/* ------------------------------------------------------------------ */
/* Vercel API                                                           */
/* ------------------------------------------------------------------ */

const baseCheck = resolveApiBase(process.env.VERCEL_API_BASE, {
  allowInsecure: String(process.env.VERCEL_API_ALLOW_INSECURE_BASE ?? "").toLowerCase() === "true",
});
if (!baseCheck.ok) fail(baseCheck.error, 2);

/**
 * هوية الرمز من `/v2/user` — تُستخدم للتشخيص فقط ولا تدخل `report` أبدًا:
 * جسم الاستجابة يحمل `uid` وهو **قيمة ORG_ID الصحيحة** في الحسابات الشخصية،
 * فطباعتها في تقرير `--json` تسريب لقيمة تُضبط سرًّا.
 */
let TOKEN = "";
let USER = {};

async function api(path_, { query } = {}) {
  const url = new URL(path_, `${baseCheck.base}/`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    }
  }
  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": "aborof/apply-vercel-link",
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
    return { ok: response.ok, status: response.status, json, error: null };
  } catch (error) {
    return { ok: false, status: 0, json: null, error };
  }
}

/* ------------------------------------------------------------------ */
/* مصادر المعرّفين                                                      */
/* ------------------------------------------------------------------ */

function readVercelProjectFile() {
  const file = path.resolve(".vercel", "project.json");
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const projectId = String(parsed.projectId ?? "").trim();
    const orgId = String(parsed.orgId ?? "").trim();
    if (!projectId || !orgId) return null;
    return { projectId, orgId, source: ".vercel/project.json", name: String(parsed.projectName ?? "") || null };
  } catch {
    return null;
  }
}

/** ‏vercel link غير تفاعلي: الرمز عبر بيئة الطفل (لا يظهر في ps ولا في السجل). */
function runVercelLink() {
  const bin = (() => {
    const which = spawnSync("bash", ["-lc", "command -v vercel"], { encoding: "utf8" });
    return which.status === 0 && which.stdout.trim() ? [which.stdout.trim()] : ["npx", "--yes", "vercel"];
  })();
  const linkArgs = ["link", "--yes", "--project", projectName];
  if (explicitOrgId) linkArgs.push("--scope", explicitOrgId);
  out(`🔗 ${bin[0]} ${bin.slice(1).join(" ")} (الرمز عبر بيئة الطفل — لا argv)`);
  const res = spawnSync(bin[0], bin.slice(1).concat(linkArgs), {
    encoding: "utf8",
    env: { ...process.env, VERCEL_TOKEN: TOKEN },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 180_000,
  });
  const text = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  if (res.status !== 0) {
    out(`⚠️  vercel link فشل (exit ${res.status}): ${text.replace(/\s+/g, " ").slice(-400)}`);
    return null;
  }
  return readVercelProjectFile();
}

/**
 * البحث بالاسم في كل النطاقات التي يراها الرمز — يصلح بلا CLI وبلا `vercel link`.
 *
 * لماذا نُعدد الفرق: `GET /v9/projects` بلا `teamId` يعيد مشاريع النطاق الافتراضي
 * للرمز فقط، فالمشروع قد يكون في فريق لا يظهر هناك. لذا: النطاق الافتراضي أولًا،
 * ثم `GET /v2/teams` وكل فريق (بحدّ أقصى) — وأول مطابقة للاسم تحمل `id` و`accountId`
 * معًا، أي الزوج الصحيح بلا أي نسخ يدوي. القيم لا تُطبع.
 */
async function deriveLinkFromApi() {
  const scopes = [{ label: "النطاق الافتراضي للرمز", teamId: null }];
  if (explicitOrgId) scopes.unshift({ label: "النطاق المُمرَّر كـ --org-id", teamId: explicitOrgId });
  const teamsRes = await api("v2/teams", { query: { limit: 50 } });
  const teams = Array.isArray(teamsRes.json?.teams) ? teamsRes.json.teams : [];
  for (const team of teams.slice(0, 10)) {
    const id = String(team?.id ?? "").trim();
    if (id && !scopes.some((s) => s.teamId === id)) scopes.push({ label: `الفريق ${String(team?.slug ?? team?.username ?? id).slice(0, 24)}`, teamId: id });
  }

  const seen = [];
  for (const scope of scopes) {
    const res = await api("v9/projects", { query: { limit: 100, teamId: scope.teamId } });
    if (!res.ok) continue;
    seen.push(...projectNames(res.json));
    const hit = findProjectByName(res.json, expectedName);
    const link = hit ? { ...hit, orgId: hit.orgId ?? scope.teamId } : null;
    if (isUsableProjectLink(link)) {
      return { ...link, source: `قائمة مشاريع الرمز — بحث بالاسم في ${scope.label}` };
    }
  }
  report.deriveSeenNames = [...new Set(seen)];
  return null;
}

async function verifyLink(link) {
  const res = await api(`v9/projects/${encodeURIComponent(link.projectId)}`, { query: { teamId: link.orgId } });
  const name = res.ok ? String(res.json?.name ?? "") : null;
  const scopes = await Promise.all([
    api("v9/projects", { query: { limit: 100, teamId: link.orgId } }),
    api("v9/projects", { query: { limit: 100 } }),
  ]);
  const diagnosis = diagnoseProjectLookup({
    status: res.status,
    projectName: name,
    expectedName,
    orgId: link.orgId,
    user: USER,
    teamScope: { status: scopes[0].status, names: scopes[0].json?.projects ?? [] },
    personalScope: { status: scopes[1].status, names: scopes[1].json?.projects ?? [] },
    error: res.error,
  });
  return { ok: diagnosis.code === "PROJECT_OK", name, diagnosis, status: res.status };
}

/* ------------------------------------------------------------------ */
/* بوابة النشر وصلاحيات GitHub                                          */
/* ------------------------------------------------------------------ */

function checkGitHubWritable(repo) {
  const res = ghApi(`/repos/${repo}/actions/secrets/public-key`);
  if (res.ok) return { ok: true, reason: null };
  if (res.forbidden) {
    return {
      ok: false,
      reason:
        "التوكن الحالي لا يملك صلاحية كتابة أسرار Actions (HTTP 403) — وهذا سلوك GitHub مع أي GitHub App " +
        "(ومنه توكن الوكيل الآلي في البيئات المسوّرة). نفّذ الأداة من جهازك بحساب المالك: gh auth status ثم أعد.",
    };
  }
  return { ok: false, reason: `تعذّرت قراءة مفتاح التشفير العام للأسرار: ${res.stderr.slice(0, 200)}` };
}

function readGate(repo) {
  const scopes = envName
    ? [`/repos/${repo}/environments/${envName}/variables/VERCEL_DEPLOY_ENABLED`, `/repos/${repo}/actions/variables/VERCEL_DEPLOY_ENABLED`]
    : [`/repos/${repo}/actions/variables/VERCEL_DEPLOY_ENABLED`, `/repos/${repo}/environments/production/variables/VERCEL_DEPLOY_ENABLED`];
  for (const endpoint of scopes) {
    const res = ghApi(endpoint);
    if (res.ok && res.data) return { found: true, value: String(res.data.value ?? ""), endpoint };
  }
  return { found: false, value: null, endpoint: scopes[0] };
}

/* ------------------------------------------------------------------ */
/* التسلسل                                                              */
/* ------------------------------------------------------------------ */

async function main() {
  out("# ربط مشروع Vercel وضبط أسرار النشر\n");

  const repo = resolveRepo();
  if (!repo) fail("تعذر تحديد المستودع. مرّر --repo owner/name أو شغّل من داخل مستودع مرتبط بـ gh.", 2);
  report.repo = repo;
  out(`المستودع: ${repo} · نطاق الأسرار: ${report.secretScope} · المشروع المتوقع: ${expectedName}\n`);

  // أ) الرمز: فحص شكلي قبل أي شبكة (يرفض القيم الموضعية ورموز المنصات الأخرى).
  const acquired = acquireToken();
  const shape = validateTokenShape(acquired.value);
  if (!shape.ok) fail(`الرمز مرفوض شكليًا (${acquired.source}): ${shape.reason}`, 1);
  TOKEN = acquired.value;
  out(`🔑 الرمز من ${acquired.source} — ${shape.shape}`);

  if (!skipVerify) {
    const userRes = await api("v2/user");
    if (!userRes.ok) {
      const detail = String(userRes.json?.error?.message ?? userRes.json?.error?.code ?? userRes.error?.message ?? "").slice(0, 200);
      fail(
        `فحص الرمز فشل — HTTP ${userRes.status}${detail ? `: ${detail}` : ""}. ` +
          (userRes.status === 404
            ? "الرمز ملغى/غير موجود — استبدله."
            : userRes.status === 403
              ? "صلاحية ناقصة على الفريق — أنشئ رمزًا بصلاحية Full access."
              : "تحقّق من الشبكة أو من VERCEL_API_BASE."),
        1
      );
    }
    USER = userRes.json?.user ?? userRes.json ?? {};
    // ‏username فقط؛ وإن غاب فشكل مقنّع للـ uid — لأن uid في الحساب الشخصي هو
    // نفسه قيمة ORG_ID الصحيحة، أي سرّ يُضبط لا معرّف يُطبع.
    report.tokenAccount = USER.username ? String(USER.username) : maskIdentifier(String(USER.uid ?? ""));
    out(`✅ الرمز صالح — حساب Vercel: ${report.tokenAccount}\n`);
  } else {
    out("⚠️  --skip-verify: لن يُفحص الرمز ولا المعرّفات قبل الضبط (لا إثبات أنها تعمل).\n");
  }

  // ب) حلّ المعرّفين من أول مصدر يتحقق فعليًا (التحقق قبل اللمس).
  const candidates = [];
  if (explicitProjectId && explicitOrgId) {
    candidates.push({ projectId: explicitProjectId, orgId: explicitOrgId, source: "الأعلام --project-id/--org-id" });
  }
  const fromFile = readVercelProjectFile();
  if (fromFile) candidates.push(fromFile);

  const acceptLink = (link, projectNameResolved) => {
    report.link = {
      projectId: maskIdentifier(link.projectId),
      orgId: maskIdentifier(link.orgId),
      projectName: projectNameResolved ?? null,
    };
    return link;
  };

  let chosen = null;
  let lastCandidate = candidates[0] ?? (explicitOrgId ? { projectId: explicitProjectId ?? "", orgId: explicitOrgId, source: "--org-id" } : null);

  if (skipVerify) {
    chosen = candidates.find((c) => isUsableProjectLink(c)) ?? null;
    if (!chosen && !skipLink) chosen = runVercelLink();
    if (!chosen) chosen = await deriveLinkFromApi();
    if (!isUsableProjectLink(chosen)) {
      fail("لم يُعثر على زوج (projectId, orgId) — مرّر --project-id و--org-id صراحةً أو أزل --skip-verify.", 1);
    }
    acceptLink(chosen, chosen.name);
  } else {
    for (const candidate of candidates) {
      if (!isUsableProjectLink(candidate)) continue;
      lastCandidate = candidate;
      const verdict = await verifyLink(candidate);
      if (verdict.ok) {
        chosen = acceptLink(candidate, verdict.name);
        out(`✅ المعرّفان محلولان من ${candidate.source} — المشروع «${verdict.name}» ضمن النطاق ${verdict.diagnosis.scopeDescribe}`);
        break;
      }
      out(`⚠️  المصدر ${candidate.source} لم يحلّ إلى «${expectedName}»: [${verdict.diagnosis.code}] ${verdict.diagnosis.headline}`);
      report.lastFailedDiagnosis = { code: verdict.diagnosis.code, headline: verdict.diagnosis.headline };
    }

    if (!chosen && !skipLink) {
      const linked = runVercelLink();
      lastCandidate = isUsableProjectLink(linked) ? linked : lastCandidate;
      if (isUsableProjectLink(linked)) {
        const verdict = await verifyLink(linked);
        if (verdict.ok) {
          chosen = acceptLink(linked, verdict.name);
          out(`✅ المعرّفان محلولان من ${linked.source} — المشروع «${verdict.name}»`);
        }
      }
    }

    if (!chosen) {
      const derived = await deriveLinkFromApi();
      lastCandidate = isUsableProjectLink(derived) ? derived : lastCandidate;
      if (isUsableProjectLink(derived)) {
        const verdict = await verifyLink(derived);
        if (verdict.ok) {
          chosen = acceptLink(derived, verdict.name);
          out(`✅ المعرّفان مستنتجان من ${derived.source} — المشروع «${verdict.name}» (بلا نسخ يدوي لأي معرّف)`);
        }
      }
    }

    if (!chosen) {
      // ج) لم يحلّ أي مصدر: الحكم الكامل (أسباب + إجراءات + الأسماء المرئية).
      const verdict = isUsableProjectLink(lastCandidate) ? await verifyLink(lastCandidate) : null;
      const diagnosis =
        verdict?.diagnosis ??
        diagnoseProjectLookup({
          status: 404,
          expectedName,
          orgId: String(lastCandidate?.orgId ?? ""),
          user: USER,
          teamScope: { status: 0, names: [] },
          personalScope: { status: 0, names: report.deriveSeenNames ?? [] },
        });
      report.diagnosis = { code: diagnosis.code, headline: diagnosis.headline, causes: diagnosis.causes, fixes: diagnosis.fixes };
      out("");
      for (const line of renderDiagnosis(diagnosis)) out(line);
      for (const line of renderVisibleProjects(diagnosis, expectedName)) out(line);
      out("");
      fail("لم يُحسم زوج (projectId, orgId) — لم يُكتب أي سرّ على GitHub (التحقق قبل اللمس).", 1);
    }
  }

  report.chosenSource = chosen.source ?? "غير معروف";
  if (!report.link) report.link = { projectId: maskIdentifier(chosen.projectId), orgId: maskIdentifier(chosen.orgId) };
  if (isPlaceholderValue(chosen.projectId) || isPlaceholderValue(chosen.orgId)) {
    fail("قيمة موضعية في المعرّفات (مثل prj_YOUR_PROJECT_ID) — رُفضت قبل الكتابة.", 1);
  }

  // د) صلاحية كتابة الأسرار تُفحص **قبل** أي محاولة.
  const writable = checkGitHubWritable(repo);
  if (!writable.ok) fail(writable.reason, 2);

  // هـ) بوابة النشر: سبب صامت لتخطّي وظيفة النشر بلا أي خطأ.
  const gate = readGate(repo);
  report.gate = gate.found ? { value: gate.value, scope: gate.endpoint } : { value: null, scope: gate.endpoint };
  if (!gate.found || gate.value !== "true") {
    out(
      `⚠️  VERCEL_DEPLOY_ENABLED = ${gate.found ? JSON.stringify(gate.value) : "غير معرّف"} — وظيفة النشر ستبقى skipped حتى لو ضُبطت الأسرار. ` +
        "المطلوب Variable (لا Secret) بالقيمة الحرفية true في نطاق المستودع أو بيئة production."
    );
  }

  // و) الضبط: ثلاث أسرار عبر stdin فقط.
  const values = {
    VERCEL_TOKEN: TOKEN,
    VERCEL_ORG_ID: chosen.orgId,
    VERCEL_PROJECT_ID: chosen.projectId,
  };
  const scopeArgs = envName ? ["--env", envName] : [];
  const plan = DEPLOY_SECRET_NAMES.map((name) => `gh secret set ${name}${envName ? ` --env ${envName}` : ""}   (القيمة عبر stdin)`);

  if (dryRun) {
    out("\n🧪 --dry-run: كل الفحوص نُفِّذت، ولن يُكتب أي سرّ. الخطوات المخطَّطة:");
    for (const line of plan) out(`   • ${line}`);
    if (dispatch) out("   • gh workflow run deploy.yml --ref main");
    out(`\nالقيم التي ستُضبط (بلا طباعة): TOKEN ${shape.shape} · ORG_ID ${maskIdentifier(chosen.orgId)} · PROJECT_ID ${maskIdentifier(chosen.projectId)}`);
    report.ok = true;
    finish(0);
  }

  for (const name of DEPLOY_SECRET_NAMES) {
    const res = gh(["secret", "set", name, ...scopeArgs], { input: values[name] });
    if (!res.ok) fail(`فشل ضبط ${name} على GitHub: ${res.stderr.slice(0, 240)}`, 1);
    report.secretsWritten.push(name);
    out(`✅ ضُبط ${name} (${maskIdentifier(values[name])})`);
  }

  // ز) التشغيل والمتابعة.
  if (dispatch) {
    // ‏target مدخل required في workflow_dispatch: يُمرَّر صراحةً حتى لا يحاول gh
    // سؤال المستخدم (يفشل بلا طرفية) وحتى لا يعتمد على الافتراضي وحده.
    const run = gh(["workflow", "run", "deploy.yml", "--ref", "main", "--repo", repo, "-f", "target=production"]);
    if (!run.ok) fail(`تعذّر تشغيل deploy.yml: ${run.stderr.slice(0, 240)}`, 1);
    out("\n🚀 شُغِّل deploy.yml على main (يظهر خلال ثوانٍ في Actions).");
    report.dispatchedRun = { requested: true };
    if (watch) await watchLatestRun(repo);
  }

  out("");
  out("بعد الضبط: أي دفع إلى main يعيد تشغيل deploy.yml تلقائيًا، أو gh workflow run deploy.yml --ref main.");
  out("تذكير: أسرار Actions لا تنتقل إلى Runtime — تأكد من TURSO_DATABASE_URL/TURSO_AUTH_TOKEN/ADMIN_PASSWORD/ADMIN_SESSION_SECRET في Vercel Project → Settings → Environment Variables (Production).");
  report.ok = true;
  finish(0);
}

/** متابعة بلا تنزيل سجلات (قد تكون محجوبة): حالة الوظائف عبر API. */
async function watchLatestRun(repo) {
  out("👀 متابعة التشغيل (حالة الوظائف عبر API — لا تنزيل سجلات)…");
  let runId = null;
  for (let attempt = 0; attempt < 10 && !runId; attempt += 1) {
    const res = ghApi(`/repos/${repo}/actions/runs?per_page=5&event=workflow_dispatch`);
    const latest = res.ok ? res.data?.workflow_runs?.[0] : null;
    if (latest && String(latest.name ?? "").includes("Deploy to Vercel")) runId = latest.id;
    if (!runId) await sleep(6_000);
  }
  if (!runId) {
    out("⚠️  لم يُرصد التشغيل — تابعه يدويًا: Actions → «Deploy to Vercel».");
    return;
  }
  report.dispatchedRun = { id: runId, url: `https://github.com/${repo}/actions/runs/${runId}` };
  out(`   ${report.dispatchedRun.url}`);
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    const jobs = ghApi(`/repos/${repo}/actions/runs/${runId}/jobs`);
    const list = jobs.ok ? jobs.data?.jobs ?? [] : [];
    if (list.length) {
      out(`   ${list.map((j) => `${j.name}: ${j.status}${j.conclusion ? `/${j.conclusion}` : ""}`).join(" · ")}`);
      const done = list.every((j) => j.status === "completed");
      if (done) {
        const failed = list.filter((j) => j.conclusion !== "success" && j.conclusion !== "skipped");
        const deployJob = list.find((j) => String(j.name).includes("Deploy to Vercel"));
        if (deployJob?.conclusion === "skipped") {
          out("⚠️  وظيفة النشر skipped ⇒ بوابة VERCEL_DEPLOY_ENABLED مغلقة (Variable بالقيمة true مطلوبة).");
        }
        if (failed.length) {
          for (const job of failed) {
            const step = (job.steps ?? []).find((s) => s.conclusion === "failure");
            out(`❌ ${job.name} فشل${step ? ` عند خطوة: ${step.name}` : ""} — التعليقات (annotations) تحمل التشخيص المُصنَّف.`);
          }
        } else {
          out("✅ اكتمل التشغيل بلا فشل.");
        }
        report.runConclusion = failed.length ? "failure" : "success";
        return;
      }
    }
    await sleep(20_000);
  }
  out("⚠️  انتهت مهلة المتابعة (15 دقيقة) — التشغيل ما زال قائمًا؛ تابعه من الرابط أعلاه.");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  fail(`استثناء غير متوقع: ${String(error?.message ?? error).slice(0, 300)}`, 1);
});
