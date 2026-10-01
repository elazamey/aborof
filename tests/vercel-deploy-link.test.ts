import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";

import {
  DEFAULT_EXPECTED_PROJECT,
  classifyOrgScope,
  diagnoseProjectLookup,
  expectedProjectMatches,
  findProjectByName,
  isPlaceholderValue,
  isUsableProjectLink,
  maskIdentifier,
  projectNames,
  renderDiagnosis,
  renderVisibleProjects,
  resolveApiBase,
  validateTokenShape,
} from "../scripts/lib/vercel-link.mjs";

/**
 * عقد هوية مشروع Vercel قبل النشر.
 *
 * الحالة الحقيقية التي أوقفت ثلاثة نشرات متتالية على main:
 *   GET /v2/user                              → 200 (الرمز صالح)
 *   GET /v9/projects/$PROJECT_ID?teamId=$ORG  → 404 Project not found
 * أي أن العطل في المعرّفين لا في الرمز، والرسالة الجافة لا تحسم أيًّا من أربعة
 * أسباب مختلفة. هذه الاختبارات تثبّت التصنيف (دوال نقية) وسلوك الأداتين ضد خادم
 * وهمي في عملية مستقلة — بلا اتصال بـ Vercel وبلا لمس GitHub.
 */

const REPO_ROOT = process.cwd();
const PREFLIGHT = path.resolve("scripts/vercel-preflight.mjs");
const APPLY = path.resolve("scripts/apply-vercel-link.mjs");
const MOCK = path.resolve("tests/fixtures/mock-vercel-api.mjs");
const TOKEN = "vercel_test_token_0123456789abcdef0123456789";
const PERSONAL_UID = "usr_personal_uid_0001";
const TEAM_ID = "team_fake_scope_0001";

const ABOROF = { name: "aborof", id: "prj_real", accountId: PERSONAL_UID };
const STORE_V2 = { name: "aborof-store-v2", id: "prj_v2", accountId: PERSONAL_UID };
const UPDATED = { name: "aborof-updated-17d3397", id: "prj_upd", accountId: PERSONAL_UID };

/* ------------------------------------------------------------------ */
/* خادم Vercel وهمي في عملية مستقلة                                     */
/* ------------------------------------------------------------------ */

type MockVercelApi = {
  url: string;
  /** كل نداء وصل إلى الخادم، بالترتيب — دليل «الرفض الشكلي بلا شبكة». */
  readLog: () => string[];
  close: () => void;
};

/**
 * يشغّل `tests/fixtures/mock-vercel-api.mjs` في **عملية مستقلة**: `spawnSync` في
 * الاختبار يحبس حلقة الأحداث، فلو عاش الخادم في عملية الاختبار نفسها لما خدم أي
 * طلب قبل انتهاء الطفل (وهو deadlock مُوثّق في mock-turso-api.mjs نفسه).
 */
function startMockVercelApi(scenario: Record<string, unknown>): Promise<MockVercelApi> {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mock-vercel-"));
    const portFile = path.join(dir, "port");
    const logFile = path.join(dir, "log");
    const child = spawn("node", [MOCK], {
      stdio: "ignore",
      env: { ...process.env, MOCK_PORT_FILE: portFile, MOCK_LOG_FILE: logFile, MOCK_SCENARIO: JSON.stringify(scenario) },
    });
    const startedAt = Date.now();
    const poll = setInterval(() => {
      const port = fs.existsSync(portFile) ? fs.readFileSync(portFile, "utf8").trim() : "";
      if (port && port !== "0") {
        clearInterval(poll);
        resolve({
          url: `http://127.0.0.1:${port}`,
          readLog: () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").split("\n").filter((l) => l && !l.startsWith("#")) : []),
          close: () => {
            child.kill("SIGKILL");
            fs.rmSync(dir, { recursive: true, force: true });
          },
        });
        return;
      }
      if (Date.now() - startedAt > 15_000) {
        clearInterval(poll);
        child.kill("SIGKILL");
        reject(new Error("الخادم الوهمي لم يبدأ خلال 15 ثانية"));
      }
    }, 50);
  });
}

/* ------------------------------------------------------------------ */
/* gh وهمي: يسجّل الاستدعاءات ويكتب الأسرار في ملفات                   */
/* ------------------------------------------------------------------ */

const FAKE_GH = `#!/usr/bin/env bash
set -uo pipefail
printf '%s\\n' "$*" >> "\${FAKE_GH_LOG:-/dev/null}"
if [ "\${1:-}" = "api" ]; then
  ep="\${2:-}"
  case "$ep" in
    */actions/secrets/public-key)
      if [ "\${FAKE_GH_FORBIDDEN:-0}" = "1" ]; then
        echo "gh: Resource not accessible by integration (HTTP 403)" >&2
        exit 1
      fi
      echo '{"key_id":"key-id","key":"cHViLWtleQ=="}'
      exit 0 ;;
    */actions/variables/VERCEL_DEPLOY_ENABLED)
      if [ "\${FAKE_GATE_MISSING:-0}" = "1" ]; then echo "not found" >&2; exit 1; fi
      echo "{\\"name\\":\\"VERCEL_DEPLOY_ENABLED\\",\\"value\\":\\"\${FAKE_GATE_VALUE:-true}\\"}"
      exit 0 ;;
    */environments/*) echo "not found" >&2; exit 1 ;;
    *) echo '{}' ; exit 0 ;;
  esac
fi
if [ "\${1:-}" = "repo" ] && [ "\${2:-}" = "view" ]; then echo "elazamey/aborof"; exit 0; fi
if [ "\${1:-}" = "secret" ] && [ "\${2:-}" = "set" ]; then
  name="\${3:-}"
  mkdir -p "$FAKE_GH_SECRETS"
  cat > "$FAKE_GH_SECRETS/$name"
  echo "Set repository secret $name"
  exit 0
fi
if [ "\${1:-}" = "workflow" ] && [ "\${2:-}" = "run" ]; then exit 0; fi
exit 0
`;

/* ------------------------------------------------------------------ */
/* 1) الدوال النقية: قيم موضعية، أشكال رموز، تقنيع                      */
/* ------------------------------------------------------------------ */

describe("vercel-link — قيم موضعية وأشكال رموز", () => {
  test("القيم الموضعية من الأوامر الجاهزة تُرصد كلها", () => {
    for (const value of [
      "prj_YOUR_PROJECT_ID",
      "team_YOUR_TEAM_ID",
      "YOUR_VERCEL_TOKEN",
      "<orgId>",
      "<الرمز الجديد>",
      "",
      "   ",
      "team_…",
      "changeme",
      "TODO",
    ]) {
      assert.equal(isPlaceholderValue(value), true, `لم يُرصد كقيمة موضعية: ${JSON.stringify(value)}`);
    }
  });

  test("القيم الحقيقية لا تُرصد كموضعية", () => {
    for (const value of ["prj_9xK2mNq7vR1tW4yB8cL3dF6g", "team_8xK2mNq7vR1t", PERSONAL_UID]) {
      assert.equal(isPlaceholderValue(value), false, `رُصد خطأً كموضعية: ${value}`);
    }
  });

  test("رمز منصة أخرى يُرفض باسم المنصة (لا يُرسل إلى Vercel)", () => {
    const github = validateTokenShape("github_pat_11ABCDEFG_abcdefghijklmnopqrstuvwxyz0123456789");
    assert.equal(github.ok, false);
    assert.match(String(github.reason), /GitHub/);

    const turso = validateTokenShape("eyJhbGciOiJFZERTQSJ9.eyJpYXQiOjE3MDB9.signaturevalue");
    assert.equal(turso.ok, false);
    assert.match(String(turso.reason), /Turso|JWT/);
  });

  test("رمز Vercel المقبول يمرّ، والقصير/الفارغ/ذي المسافة يُرفض", () => {
    assert.equal(validateTokenShape(TOKEN).ok, true);
    assert.equal(validateTokenShape("").ok, false);
    assert.equal(validateTokenShape("short").ok, false);
    assert.match(String(validateTokenShape(`${TOKEN}\n`).reason ?? ""), /مسافة|سطر/);
  });

  test("التقنيع لا يكشف المعرّف ويحفظ الطول", () => {
    const masked = maskIdentifier("prj_9xK2mNq7vR1tW4yB8cL3dF6g");
    assert.ok(!masked.includes("prj_9xK2mNq7vR1tW4yB8cL3dF6g"), "القناع كشف القيمة كاملة");
    assert.ok(!masked.includes("9xK2mNq7vR1tW4yB"), "القناع كشف منتصف القيمة");
    assert.match(masked, /طول 28/);
    assert.equal(maskIdentifier(""), "—");
    assert.ok(!maskIdentifier("team_x").includes("team_x"), "المعرّفات القصيرة تُقنّع بالطول فقط");
  });

  test("قاعدة API: https إلزامي، والاستثناء المحلي للاختبارات فقط", () => {
    assert.equal(resolveApiBase(undefined).base, "https://api.vercel.com");
    assert.equal(resolveApiBase("http://127.0.0.1:9999").ok, false);
    const insecure = resolveApiBase("http://127.0.0.1:9999", { allowInsecure: true });
    assert.equal(insecure.ok, true);
    assert.equal(insecure.insecure, true);
    assert.equal(resolveApiBase("http://evil.example.com", { allowInsecure: true }).ok, false);
  });
});

/* ------------------------------------------------------------------ */
/* 2) تصنيف نطاق ORG_ID                                                 */
/* ------------------------------------------------------------------ */

describe("vercel-link — تصنيف نطاق VERCEL_ORG_ID", () => {
  const user = { username: "canyoudfg-3243", uid: PERSONAL_UID };

  test("نطاق فريق مقابل نطاق شخصي مطابق لحساب الرمز", () => {
    assert.equal(classifyOrgScope(TEAM_ID, user).kind, "team");
    assert.equal(classifyOrgScope(PERSONAL_UID, user).kind, "personal-uid");
    assert.equal(classifyOrgScope("", user).kind, "empty");
  });

  test("فخّ اسم المستخدم بدل المعرّف يُرصد", () => {
    const scope = classifyOrgScope("canyoudfg-3243", user);
    assert.equal(scope.kind, "username");
    assert.equal(scope.matchesTokenUsername, true);
    assert.match(scope.describe(), /اسم مستخدم لا معرّف نطاق/);
  });

  test("الوصف المطبوع لا يحمل القيمة", () => {
    const scope = classifyOrgScope(TEAM_ID, user);
    assert.ok(!scope.describe().includes(TEAM_ID), "الوصف كشف قيمة ORG_ID");
    assert.match(scope.describe(), /team_/);
  });

  test("استخراج الهوية من شكلَي استجابة /v2/user", () => {
    assert.equal(classifyOrgScope(PERSONAL_UID, { user }).matchesTokenUserUid, true);
    assert.equal(classifyOrgScope(PERSONAL_UID, user).matchesTokenUserUid, true);
  });
});

/* ------------------------------------------------------------------ */
/* 3) تشخيص 404 — الحالات الأربع                                        */
/* ------------------------------------------------------------------ */

describe("vercel-link — تشخيص فشل فحص المشروع", () => {
  const user = { username: "canyoudfg-3243", uid: PERSONAL_UID };
  const projects = (names: string[]) => ({ status: 200, names });

  test("حالة الإنتاج الفعلية: نطاق فريق بينما المشروع شخصي", () => {
    const diagnosis = diagnoseProjectLookup({
      status: 404,
      expectedName: "aborof",
      orgId: TEAM_ID,
      user,
      teamScope: projects([]),
      personalScope: projects(["aborof", "aborof-store-v2"]),
    });
    assert.equal(diagnosis.code, "PROJECT_NOT_FOUND_WRONG_SCOPE");
    assert.match(diagnosis.headline, /النطاق الشخصي/);
    assert.ok(diagnosis.fixes.join(" ").includes("vercel link"), "الإصلاح يجب أن يذكر vercel link");
    assert.ok(diagnosis.fixes.join(" ").includes("orgId"), "الإصلاح يجب أن يسمّي orgId");
  });

  test("معرّف قديم مع اسم صحيح: المشروع مرئي لكن PROJECT_ID لا يطابقه", () => {
    const diagnosis = diagnoseProjectLookup({
      status: 404,
      expectedName: "aborof",
      orgId: PERSONAL_UID,
      user,
      teamScope: { status: 0, names: [] },
      personalScope: projects(["aborof"]),
    });
    assert.equal(diagnosis.code, "PROJECT_NOT_FOUND_STALE_ID");
    assert.match(diagnosis.causes.join(" "), /أُعيد إنشاؤه|معرّف مشروع آخر/);
  });

  test("المشروع في حساب آخر: غير مرئي إطلاقًا للرمز", () => {
    const diagnosis = diagnoseProjectLookup({
      status: 404,
      expectedName: "aborof",
      orgId: TEAM_ID,
      user,
      teamScope: projects(["some-other-project"]),
      personalScope: projects(["unrelated"]),
    });
    assert.equal(diagnosis.code, "PROJECT_NOT_VISIBLE_TO_TOKEN");
    assert.match(diagnosis.causes.join(" "), /حساب|فريق/);
  });

  test("الرمز لا يرى أي مشروع (صلاحية ناقصة أو حساب فارغ)", () => {
    const diagnosis = diagnoseProjectLookup({
      status: 404,
      expectedName: "aborof",
      orgId: TEAM_ID,
      user,
      teamScope: { status: 403, names: [] },
      personalScope: projects([]),
    });
    assert.equal(diagnosis.code, "TOKEN_SEES_NO_PROJECTS");
    assert.match(diagnosis.causes.join(" "), /403/);
  });

  test("200 باسم مختلف ⇒ «نشر ناجح وإنتاج لم يتغير» يُحاجب", () => {
    const diagnosis = diagnoseProjectLookup({
      status: 200,
      projectName: "aborof-store-v2",
      expectedName: "aborof",
      orgId: PERSONAL_UID,
      user,
      teamScope: projects([]),
      personalScope: projects(["aborof", "aborof-store-v2", "aborof-updated-17d3397"]),
    });
    assert.equal(diagnosis.code, "PROJECT_NAME_MISMATCH");
    assert.match(diagnosis.headline, /الإنتاج لن يتغير|الإنتاج لم يتغير/);
    assert.match(diagnosis.causes.join(" "), /aborof-store-v2/);
  });

  test("200 بالاسم المطلوب ⇒ PROJECT_OK بلا إجراءات", () => {
    const diagnosis = diagnoseProjectLookup({
      status: 200,
      projectName: "aborof",
      expectedName: DEFAULT_EXPECTED_PROJECT,
      orgId: PERSONAL_UID,
      user,
    });
    assert.equal(diagnosis.code, "PROJECT_OK");
    assert.deepEqual(diagnosis.fixes, []);
  });

  test("الرمز مرفوض (401/403) يُصنَّف كصلاحية لا كمعرّف", () => {
    assert.equal(diagnoseProjectLookup({ status: 401, orgId: PERSONAL_UID, user }).code, "SCOPE_FORBIDDEN");
    assert.equal(diagnoseProjectLookup({ status: 403, orgId: TEAM_ID, user }).code, "SCOPE_FORBIDDEN");
    assert.equal(diagnoseProjectLookup({ status: 429, orgId: TEAM_ID, user }).code, "RATE_LIMITED");
    assert.equal(diagnoseProjectLookup({ status: 503, orgId: TEAM_ID, user }).code, "SERVER_ERROR");
  });

  test("تعذّر الوصول يُصنَّف كشبكة", () => {
    const diagnosis = diagnoseProjectLookup({ status: 0, orgId: TEAM_ID, user, error: new Error("fetch failed") });
    assert.equal(diagnosis.code, "API_UNREACHABLE");
  });

  test("لا حكم يسرّب قيمة معرّف في أسبابه أو إجراءاته", () => {
    const projectId = "prj_9xK2mNq7vR1tW4yB8cL3dF6g";
    for (const status of [404, 200, 403, 0]) {
      const diagnosis = diagnoseProjectLookup({
        status,
        projectName: "aborof-store-v2",
        expectedName: "aborof",
        orgId: TEAM_ID,
        user,
        teamScope: projects(["aborof"]),
        personalScope: projects(["aborof"]),
      });
      const text = renderDiagnosis(diagnosis).join("\n") + renderVisibleProjects(diagnosis).join("\n");
      assert.ok(!text.includes(TEAM_ID), `سرّب ORG_ID عند HTTP ${status}`);
      assert.ok(!text.includes(projectId), `سرّب PROJECT_ID عند HTTP ${status}`);
      assert.ok(text.length > 20, `لا تشخيص عند HTTP ${status}`);
    }
  });

  test("قائمة المشاريع المرئية تعلّم المطلوب وتقبل الأسماء والكائنات", () => {
    const body = { projects: [ABOROF, STORE_V2] };
    assert.deepEqual(projectNames(body), ["aborof", "aborof-store-v2"]);
    assert.deepEqual(projectNames(["aborof", ""]), ["aborof"]);
    const diagnosis = diagnoseProjectLookup({
      status: 404,
      expectedName: "aborof",
      orgId: PERSONAL_UID,
      user,
      teamScope: { status: 0, names: [] },
      personalScope: { status: 200, names: body.projects },
    });
    assert.match(renderVisibleProjects(diagnosis, "aborof").join("\n"), /aborof\s+← المطلوب/);
  });

  test("البحث بالاسم يعيد الزوج الصحيح (id + accountId) ولا يعيده عند الغياب", () => {
    const hit = findProjectByName({ projects: [{ ...STORE_V2, accountId: TEAM_ID }, ABOROF] }, "aborof");
    assert.deepEqual(hit, { name: "aborof", projectId: "prj_real", orgId: PERSONAL_UID, framework: null });
    assert.equal(isUsableProjectLink(hit), true);
    assert.equal(findProjectByName({ projects: [ABOROF] }, "غير-موجود"), null);
    assert.equal(isUsableProjectLink({ name: "aborof", projectId: "prj_real", orgId: "" }), false);
    assert.equal(expectedProjectMatches("Aborof", "aborof"), true);
    assert.equal(expectedProjectMatches("aborof-store-v2", "aborof"), false);
  });
});

/* ------------------------------------------------------------------ */
/* 4) الطيران التمهيدي في CI                                            */
/* ------------------------------------------------------------------ */

describe("scripts/vercel-preflight.mjs — CI (خادم وهمي)", () => {
  function runPreflight(base: string, env: Record<string, string>, extra: string[] = []) {
    const res = spawnSync(process.execPath, [PREFLIGHT, ...extra], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 60_000,
      env: {
        ...process.env,
        VERCEL_API_BASE: base,
        VERCEL_API_ALLOW_INSECURE_BASE: "true",
        VERCEL_TOKEN: TOKEN,
        VERCEL_ORG_ID: PERSONAL_UID,
        VERCEL_PROJECT_ID: "prj_good",
        ...env,
      },
    });
    return { status: res.status ?? -1, output: `${res.stdout ?? ""}${res.stderr ?? ""}` };
  }

  test("الهوية السليمة: exit 0 مع إشعارَي الرمز والاسم", async () => {
    const mock = await startMockVercelApi({
      resolved: { [`prj_good|${PERSONAL_UID}`]: { status: 200, name: "aborof", framework: "nextjs" } },
    });
    try {
      const run = runPreflight(mock.url, {});
      assert.equal(run.status, 0, run.output);
      assert.match(run.output, /::notice::Vercel token صالح — الحساب: canyoudfg-3243/);
      assert.match(run.output, /مشروع Vercel متاح — الاسم: aborof/);
      assert.match(run.output, /تطابق الاسم المتوقع/);
      assert.deepEqual(mock.readLog(), [
        "GET /v2/user",
        `GET /v9/projects/prj_good?teamId=${PERSONAL_UID}`,
      ], "الفحص الناجح يجب أن يقتصر على قراءتي الهوية والمشروع");
      assert.ok(!run.output.includes(TOKEN), "لا يجوز طباعة رمز Vercel");
    } finally {
      mock.close();
    }
  });

  test("حالة الإنتاج: 404 مع نطاق فريق ⇒ حكم مُصنَّف وأسماء المشاريع المرئية", async () => {
    const mock = await startMockVercelApi({
      projects: { "": [ABOROF, STORE_V2], [TEAM_ID]: [] },
      defaultLookup: { status: 404, message: "Project not found" },
    });
    try {
      const run = runPreflight(mock.url, { VERCEL_ORG_ID: TEAM_ID, VERCEL_PROJECT_ID: "prj_stale_id_0001" });
      assert.equal(run.status, 1, run.output);
      assert.match(run.output, /::error::\[PROJECT_NOT_FOUND_WRONG_SCOPE\]/);
      assert.match(run.output, /aborof/, "أسماء المشاريع المرئية يجب أن تُطبع");
      assert.match(run.output, /الإجراءات:/);
      assert.ok(!run.output.includes(TEAM_ID), "سرّب ORG_ID في السجل");
      assert.ok(!run.output.includes("prj_stale_id_0001"), "سرّب PROJECT_ID في السجل");
      assert.ok(
        mock.readLog().some((line) => line.includes("GET /v9/projects?")),
        "يجب سؤال قائمة المشاريع عند الفشل"
      );
      assert.ok(mock.readLog().every((line) => line.startsWith("GET ")), "التشخيص عند الفشل يجب أن يبقى للقراءة فقط");
      assert.ok(!run.output.includes(TOKEN), "لا يجوز طباعة رمز Vercel عند الفشل");
    } finally {
      mock.close();
    }
  });

  test("اسم مشروع مختلف ⇒ فشل حاجب يمنع «نشر ناجح وإنتاج لم يتغير»", async () => {
    const mock = await startMockVercelApi({
      resolved: { [`prj_other_project|${PERSONAL_UID}`]: { status: 200, name: "aborof-store-v2" } },
      projects: { "": [ABOROF, STORE_V2, UPDATED] },
    });
    try {
      const env = { VERCEL_PROJECT_ID: "prj_other_project" };
      const run = runPreflight(mock.url, env);
      assert.equal(run.status, 1, run.output);
      assert.match(run.output, /PROJECT_NAME_MISMATCH/);

      const json = runPreflight(mock.url, env, ["--json"]);
      const report = JSON.parse(json.output.slice(json.output.indexOf("{"))) as { diagnosis: { code: string } };
      assert.equal(report.diagnosis.code, "PROJECT_NAME_MISMATCH");
      // ‏uid الحساب الشخصي = قيمة ORG_ID الصحيحة ⇒ لا يجوز أن تظهر في تقرير.
      assert.ok(!json.output.includes(PERSONAL_UID), "تقرير --json سرّب uid/ORG_ID");
    } finally {
      mock.close();
    }
  });

  test("الاسم المتوقع يُتجاوز بـ --expected وبمتغير البيئة", async () => {
    const mock = await startMockVercelApi({
      resolved: { [`prj_other_project|${PERSONAL_UID}`]: { status: 200, name: "aborof-store-v2" } },
      projects: { "": [ABOROF, STORE_V2] },
    });
    try {
      const viaVar = runPreflight(mock.url, { VERCEL_PROJECT_ID: "prj_other_project", VERCEL_EXPECTED_PROJECT: "aborof-store-v2" });
      assert.equal(viaVar.status, 0, viaVar.output);
      const viaFlag = runPreflight(mock.url, { VERCEL_PROJECT_ID: "prj_other_project" }, ["--expected", "aborof-store-v2"]);
      assert.equal(viaFlag.status, 0, viaFlag.output);
    } finally {
      mock.close();
    }
  });

  test("رمز مرفوض ⇒ exit 1 برسالة استبدال الرمز", async () => {
    const mock = await startMockVercelApi({ userStatus: 403 });
    try {
      const run = runPreflight(mock.url, {});
      assert.equal(run.status, 1, run.output);
      assert.match(run.output, /::error::فحص رمز Vercel فشل — HTTP 403/);
      assert.match(run.output, /Full access/);
      assert.equal(mock.readLog().length, 1, "لا يجوز سؤال المشاريع بعد رفض الرمز");
    } finally {
      mock.close();
    }
  });

  test("سرّ غائب ⇒ exit 2 (بلا أي نداء شبكة)", async () => {
    const mock = await startMockVercelApi({});
    try {
      const run = runPreflight(mock.url, { VERCEL_PROJECT_ID: "" });
      assert.equal(run.status, 2, run.output);
      assert.match(run.output, /::error::سرّ ناقص: VERCEL_PROJECT_ID/);
      assert.deepEqual(mock.readLog(), [], "لا يجوز أي نداء شبكة مع سرّ ناقص");
    } finally {
      mock.close();
    }
  });

  test("قاعدة API غير https تُرفض (exit 2) إلا بإذن الاختبارات", () => {
    const run = spawnSync(process.execPath, [PREFLIGHT], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        VERCEL_API_BASE: "http://127.0.0.1:1",
        VERCEL_TOKEN: TOKEN,
        VERCEL_ORG_ID: PERSONAL_UID,
        VERCEL_PROJECT_ID: "prj_good",
      },
    });
    assert.equal(run.status, 2);
    assert.match(`${run.stdout}${run.stderr}`, /يجب أن تكون https/);
  });
});

/* ------------------------------------------------------------------ */
/* 5) أداة المالك: ربط + ضبط أسرار                                     */
/* ------------------------------------------------------------------ */

describe("scripts/apply-vercel-link.mjs — جهاز المالك (خادم وهمي + gh وهمي)", () => {
  let binDir = "";
  let workDir = "";
  let secretsDir = "";
  let ghLog = "";

  before(() => {
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), "aborof-bin-"));
    fs.writeFileSync(path.join(binDir, "gh"), FAKE_GH, { mode: 0o755 });
  });

  after(() => {
    fs.rmSync(binDir, { recursive: true, force: true });
  });

  function freshWorkdir() {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "aborof-link-"));
    secretsDir = path.join(workDir, "secrets");
    ghLog = path.join(workDir, "gh.log");
    fs.mkdirSync(secretsDir, { recursive: true });
    fs.writeFileSync(ghLog, "");
  }

  function runApply(base: string, args: string[], env: Record<string, string> = {}) {
    const res = spawnSync(process.execPath, [APPLY, "--repo", "elazamey/aborof", ...args], {
      cwd: workDir,
      encoding: "utf8",
      timeout: 90_000,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        VERCEL_API_BASE: base,
        VERCEL_API_ALLOW_INSECURE_BASE: "true",
        VERCEL_TOKEN: TOKEN,
        FAKE_GH_LOG: ghLog,
        FAKE_GH_SECRETS: secretsDir,
        GITHUB_REPOSITORY: "",
        ...env,
      },
    });
    const log = fs.existsSync(ghLog) ? fs.readFileSync(ghLog, "utf8") : "";
    const written: Record<string, string> = {};
    for (const name of ["VERCEL_TOKEN", "VERCEL_ORG_ID", "VERCEL_PROJECT_ID"]) {
      const file = path.join(secretsDir, name);
      if (fs.existsSync(file)) written[name] = fs.readFileSync(file, "utf8");
    }
    return { status: res.status ?? -1, output: `${res.stdout ?? ""}${res.stderr ?? ""}`, log, written };
  }

  /** العالم السليم: المشروع aborof يحلّ في النطاق الشخصي للرمز. */
  const healthy = () => ({
    resolved: { [`prj_real|${PERSONAL_UID}`]: { status: 200, name: "aborof", framework: "nextjs" } },
    projects: { "": [ABOROF, STORE_V2] },
  });

  test("المسار الذهبي: معرّفات صريحة ⇒ ثلاث أسرار عبر stdin بلا طباعة قيمة", async () => {
    const mock = await startMockVercelApi(healthy());
    freshWorkdir();
    try {
      const run = runApply(mock.url, ["--project-id", "prj_real", "--org-id", PERSONAL_UID, "--skip-link"]);
      assert.equal(run.status, 0, run.output);
      assert.deepEqual(run.written, { VERCEL_TOKEN: TOKEN, VERCEL_ORG_ID: PERSONAL_UID, VERCEL_PROJECT_ID: "prj_real" });
      assert.ok(!run.output.includes(TOKEN), "طُبع الرمز في المخرجات");
      assert.ok(!run.output.includes(PERSONAL_UID), "طُبع ORG_ID في المخرجات");
      assert.match(run.log, /secret set VERCEL_TOKEN/);
      assert.ok(!/workflow run/.test(run.log), "لا يجوز تشغيل workflow بلا --dispatch");
    } finally {
      mock.close();
    }
  });

  test("الإصلاح التلقائي: بلا أي معرّف ⇒ يستنتج الزوج الصحيح من قائمة الرمز بالاسم", async () => {
    const mock = await startMockVercelApi(healthy());
    freshWorkdir();
    try {
      const run = runApply(mock.url, ["--skip-link"]);
      assert.equal(run.status, 0, run.output);
      assert.equal(run.written.VERCEL_PROJECT_ID, "prj_real");
      assert.equal(run.written.VERCEL_ORG_ID, PERSONAL_UID);
      assert.match(run.output, /مستنتجان من|بحث بالاسم/);
      assert.match(run.log, /secret set VERCEL_PROJECT_ID/);
    } finally {
      mock.close();
    }
  });

  test("فريق: البحث يمتد إلى /v2/teams حين لا يظهر المشروع في النطاق الافتراضي", async () => {
    const mock = await startMockVercelApi({
      teams: [TEAM_ID],
      projects: { "": [{ name: "unrelated", id: "prj_u", accountId: PERSONAL_UID }], [TEAM_ID]: [{ ...ABOROF, accountId: TEAM_ID }] },
      resolved: { [`prj_real|${TEAM_ID}`]: { status: 200, name: "aborof" } },
    });
    freshWorkdir();
    try {
      const run = runApply(mock.url, ["--skip-link"]);
      assert.equal(run.status, 0, run.output);
      assert.equal(run.written.VERCEL_ORG_ID, TEAM_ID, "orgId يجب أن يكون معرّف الفريق لا الحساب الشخصي");
      assert.equal(run.written.VERCEL_PROJECT_ID, "prj_real");
    } finally {
      mock.close();
    }
  });

  test("مشروع غير مرئي ⇒ exit 1 وبلا كتابة أي سرّ (التحقق قبل اللمس)", async () => {
    const mock = await startMockVercelApi({
      username: "someone-else",
      projects: { "": [{ name: "totally-other-store", id: "prj_o", accountId: PERSONAL_UID }] },
      defaultLookup: { status: 404, message: "Project not found" },
    });
    freshWorkdir();
    try {
      const run = runApply(mock.url, ["--project-id", "prj_wrong", "--org-id", TEAM_ID, "--skip-link"]);
      assert.equal(run.status, 1, run.output);
      assert.deepEqual(run.written, {}, "كُتب سرّ قبل حسم المعرّفات");
      assert.ok(!/secret set/.test(run.log), "استُدعي gh secret set رغم الفشل");
      assert.match(run.output, /PROJECT_NOT_VISIBLE_TO_TOKEN|TOKEN_SEES_NO_PROJECTS/);
      assert.match(run.output, /totally-other-store/, "يجب عرض الأسماء المرئية للمقارنة");
    } finally {
      mock.close();
    }
  });

  test("قيمة موضعية في الرمز ⇒ رفض قبل أي نداء شبكة", async () => {
    const mock = await startMockVercelApi(healthy());
    freshWorkdir();
    try {
      const run = runApply(mock.url, ["--skip-link"], { VERCEL_TOKEN: "YOUR_VERCEL_TOKEN" });
      assert.equal(run.status, 1, run.output);
      assert.match(run.output, /موضعية/);
      assert.deepEqual(mock.readLog(), [], "لا يجوز أي نداء شبكة برمز موضعي");
      assert.deepEqual(run.written, {});
    } finally {
      mock.close();
    }
  });

  test("رمز GitHub بدل Vercel ⇒ رفض باسم المنصة", async () => {
    const mock = await startMockVercelApi(healthy());
    freshWorkdir();
    try {
      const run = runApply(mock.url, ["--skip-link"], { VERCEL_TOKEN: "ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD" });
      assert.equal(run.status, 1, run.output);
      assert.match(run.output, /GitHub/);
      assert.deepEqual(mock.readLog(), []);
    } finally {
      mock.close();
    }
  });

  test("403 على كتابة الأسرار ⇒ exit 2 برسالة صلاحية GitHub App", async () => {
    const mock = await startMockVercelApi(healthy());
    freshWorkdir();
    try {
      const run = runApply(mock.url, ["--project-id", "prj_real", "--org-id", PERSONAL_UID, "--skip-link"], { FAKE_GH_FORBIDDEN: "1" });
      assert.equal(run.status, 2, run.output);
      assert.match(run.output, /Resource not accessible by integration|GitHub App/);
      assert.deepEqual(run.written, {});
    } finally {
      mock.close();
    }
  });

  test("--dry-run: كل الفحوص تعمل ولا يُكتب سرّ", async () => {
    const mock = await startMockVercelApi(healthy());
    freshWorkdir();
    try {
      const run = runApply(mock.url, ["--project-id", "prj_real", "--org-id", PERSONAL_UID, "--skip-link", "--dry-run"]);
      assert.equal(run.status, 0, run.output);
      assert.deepEqual(run.written, {});
      assert.match(run.output, /--dry-run/);
      assert.match(run.output, /gh secret set VERCEL_PROJECT_ID/);
    } finally {
      mock.close();
    }
  });

  test("--dispatch يشغّل deploy.yml على main بمدخل target الصريح", async () => {
    const mock = await startMockVercelApi(healthy());
    freshWorkdir();
    try {
      const run = runApply(mock.url, ["--project-id", "prj_real", "--org-id", PERSONAL_UID, "--skip-link", "--dispatch", "--no-watch"]);
      assert.equal(run.status, 0, run.output);
      assert.match(run.log, /workflow run deploy\.yml --ref main --repo elazamey\/aborof -f target=production/);
    } finally {
      mock.close();
    }
  });

  test("بوابة VERCEL_DEPLOY_ENABLED مغلقة ⇒ تحذير صريح لا فشل صامت", async () => {
    const mock = await startMockVercelApi(healthy());
    freshWorkdir();
    try {
      const run = runApply(mock.url, ["--project-id", "prj_real", "--org-id", PERSONAL_UID, "--skip-link"], { FAKE_GATE_VALUE: "false" });
      assert.equal(run.status, 0, run.output);
      assert.match(run.output, /VERCEL_DEPLOY_ENABLED = "false"/);
      assert.match(run.output, /skipped/);
    } finally {
      mock.close();
    }
  });

  test("--json يعيد تقريرًا آليًا بلا قيم سرية", async () => {
    const mock = await startMockVercelApi(healthy());
    freshWorkdir();
    try {
      const run = runApply(mock.url, ["--project-id", "prj_real", "--org-id", PERSONAL_UID, "--skip-link", "--json"]);
      assert.equal(run.status, 0, run.output);
      const report = JSON.parse(run.output.slice(run.output.indexOf("{"))) as {
        ok: boolean;
        secretsWritten: string[];
        link: { projectId: string; orgId: string };
      };
      assert.equal(report.ok, true);
      assert.deepEqual(report.secretsWritten, ["VERCEL_TOKEN", "VERCEL_ORG_ID", "VERCEL_PROJECT_ID"]);
      assert.ok(!JSON.stringify(report).includes(TOKEN), "التقرير سرّب الرمز");
      assert.ok(!JSON.stringify(report).includes(PERSONAL_UID), "التقرير سرّب ORG_ID");
      assert.match(report.link.orgId, /طول/);
    } finally {
      mock.close();
    }
  });

  test("--env يضبط الأسرار على نطاق البيئة", async () => {
    const mock = await startMockVercelApi(healthy());
    freshWorkdir();
    try {
      const run = runApply(mock.url, ["--project-id", "prj_real", "--org-id", PERSONAL_UID, "--skip-link", "--env", "production"]);
      assert.equal(run.status, 0, run.output);
      assert.match(run.log, /secret set VERCEL_TOKEN --env production/);
    } finally {
      mock.close();
    }
  });

  test(".vercel/project.json القديم لا يُقبل إن لم يحلّ إلى المشروع المطلوب", async () => {
    const mock = await startMockVercelApi({
      ...healthy(),
      resolved: { [`prj_real|${PERSONAL_UID}`]: { status: 200, name: "aborof", framework: "nextjs" } },
    });
    freshWorkdir();
    fs.mkdirSync(path.join(workDir, ".vercel"), { recursive: true });
    fs.writeFileSync(
      path.join(workDir, ".vercel", "project.json"),
      JSON.stringify({ projectId: "prj_deleted_old", orgId: TEAM_ID, projectName: "aborof" })
    );
    try {
      const run = runApply(mock.url, ["--skip-link"]);
      assert.equal(run.status, 0, run.output);
      assert.match(run.output, /لم يحلّ إلى/, "يجب الإعلان أن المصدر الأول فشل");
      assert.equal(run.written.VERCEL_PROJECT_ID, "prj_real", "يجب الإصلاح من قائمة الرمز لا من الملف القديم");
      assert.equal(run.written.VERCEL_ORG_ID, PERSONAL_UID);
    } finally {
      mock.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/* 6) تركيب الأداة في المستودع                                          */
/* ------------------------------------------------------------------ */

describe("تركيب أدوات Vercel في المستودع", () => {
  const workflow = fs.readFileSync(".github/workflows/deploy.yml", "utf8");

  test("deploy.yml يستدعي الطيران التمهيدي الجديد لا bash+jq", () => {
    assert.match(workflow, /Vercel preflight/, "خطوة الطيران التمهيدي مفقودة");
    assert.match(workflow, /node scripts\/vercel-preflight\.mjs/, "الخطوة يجب أن تستدعي السكربت المُصنِّف");
    assert.ok(!/curl -sS -m 20 -o "\$user_body"/.test(workflow), "بقي كود bash القديم للطيران التمهيدي");
  });

  test("الاسم المتوقع يُقرأ كمتغير (لا سرّ) وله افتراضي في المكتبة", () => {
    assert.match(workflow, /VERCEL_EXPECTED_PROJECT: \$\{\{ vars\.VERCEL_EXPECTED_PROJECT \}\}/);
    assert.equal(DEFAULT_EXPECTED_PROJECT, "aborof");
  });

  test("الأدوات مركّبة في package.json", () => {
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    assert.match(pkg.scripts["vercel:preflight"] ?? "", /vercel-preflight\.mjs/);
    assert.match(pkg.scripts["link:vercel"] ?? "", /apply-vercel-link\.mjs/);
  });

  test("لا قيمة سرية مكتوبة في ملفات الأدوات", () => {
    for (const file of ["scripts/vercel-preflight.mjs", "scripts/apply-vercel-link.mjs", "scripts/lib/vercel-link.mjs", ".github/workflows/vercel-preflight-only.yml"]) {
      const text = fs.readFileSync(file, "utf8");
      assert.ok(!/prj_[A-Za-z0-9]{10,}/.test(text), `${file} يحمل معرّف مشروع حقيقي`);
      assert.ok(!/team_[A-Za-z0-9]{10,}/.test(text), `${file} يحمل معرّف فريق حقيقي`);
    }
  });
});

describe(".github/workflows/vercel-preflight-only.yml — فحص يدوي بلا نشر", () => {
  const workflow = fs.readFileSync(".github/workflows/vercel-preflight-only.yml", "utf8");
  const executable = workflow.replace(/^\s*#.*$/gm, "");

  test("تشغيل يدوي فقط وعلى main قبل استخدام أسرار الإنتاج", () => {
    assert.match(executable, /^on:\s*\n\s+workflow_dispatch:\s*$/m);
    assert.doesNotMatch(executable, /^\s*(push|pull_request|pull_request_target|schedule|workflow_call|workflow_run):/m);
    assert.match(executable, /if: \$\{\{ github\.ref == 'refs\/heads\/main' \}\}/);
    assert.match(executable, /environment: production/);
    assert.match(executable, /timeout-minutes: 5/);
  });

  test("صلاحيات قراءة فقط ولا يحتفظ checkout ببيانات GitHub", () => {
    assert.match(executable, /permissions:\s*\n\s+contents: read/);
    assert.doesNotMatch(executable, /:\s*write\b|\bwrite-all\b/);
    assert.match(executable, /persist-credentials: false/);
    assert.match(executable, /fetch-depth: 1/);
  });

  test("المدخلات من Secrets والاسم المتوقع من Variables مع حاجز للنقص", () => {
    for (const name of ["VERCEL_TOKEN", "VERCEL_ORG_ID", "VERCEL_PROJECT_ID"]) {
      assert.ok(executable.includes(name + ": ${{ secrets." + name + " }}"), `${name} يجب أن يُقرأ من Secrets`);
    }
    assert.match(executable, /VERCEL_EXPECTED_PROJECT: \$\{\{ vars\.VERCEL_EXPECTED_PROJECT \}\}/);
    assert.match(executable, /for var in VERCEL_TOKEN VERCEL_ORG_ID VERCEL_PROJECT_ID; do/);
    assert.match(executable, /if \[ -z "\$\{!var:-\}" \]; then[\s\S]*?exit 1/);
  });

  test("يشغّل سكربت الفحص فقط بلا CLI أو تثبيت أو بناء أو كتابة أسرار", () => {
    assert.match(executable, /uses: actions\/checkout@v7/);
    assert.match(executable, /uses: actions\/setup-node@v7/);
    assert.match(executable, /node-version: 20/);
    assert.match(executable, /node scripts\/vercel-preflight\.mjs/);
    assert.doesNotMatch(executable, /\b(npm|npx|vercel|gh)\s/);
    assert.doesNotMatch(executable, /apply-vercel-link\.mjs|deploy\.yml|VERCEL_DEPLOY_ENABLED/);
    assert.equal((executable.match(/^\s+- name:/gm) ?? []).length, 4);
  });
});
