#!/usr/bin/env node
/**
 * تدريب تدوير الاعتماد — الجزء المُرمَّز من إجراء التدوير
 * (docs/ops/secret-rotation.md §7):
 *
 *   node scripts/rotation-drill.mjs --phase pre    # قبل التدوير: التقاط خط الأساس
 *   ... التدوير عبر apply-turso-secrets.sh + vercel deploy --prod ...
 *   node scripts/rotation-drill.mjs --phase post   # بعد التدوير: إثبات الشفاء
 *   node scripts/rotation-drill.mjs --phase pre --json   # سجل آلي للصق في جدول الأدلة
 *   node scripts/rotation-drill.mjs --self-test    # إثبات ميكانيكا الالتقاط (بلا أسرار)
 *
 * كل طور يشغّل: المجسّ (`verify-turso --json`) + الـ smoke (`--json`) اختياريًا
 * عند ضبط `SMOKE_BASE` فقط. «إجراء التدوير = ناجح» لا يُدَّعَى إلا بسجلَي
 * pre/post خضراوَين — الادعاء الشفهي مرفوض.
 *
 * البيئة: TURSO_DATABASE_URL + TURSO_AUTH_TOKEN_CI (أو المشترك) للمجسّ،
 * وSMOKE_BASE للـ smoke. لا تُطبَع أي قيمة سرية — الأحكام فقط.
 * كود الخروج: 0 = المجسّ PASS والـ smoke ليس FAIL، 1 = حجب/فشل، 2 = استخدام خاطئ.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const val = (n) => {
  const i = args.indexOf(n);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
};

if (flag("--help") || flag("-h")) {
  console.log("الاستخدام: node scripts/rotation-drill.mjs --phase pre|post [--json] | --self-test");
  process.exit(0);
}

function runJson(cmd, cmdArgs, env) {
  const res = spawnSync(cmd, cmdArgs, { encoding: "utf8", env, timeout: 180_000 });
  const out = String(res.stdout ?? "");
  try {
    const start = out.indexOf("{");
    const parsed = JSON.parse(start >= 0 ? out.slice(start) : out);
    return { parsed, status: res.status ?? 1, raw: out };
  } catch {
    return { parsed: null, status: 2, raw: out.slice(0, 400) };
  }
}

function probeVerdict(env) {
  const { parsed, status } = runJson("node", ["scripts/verify-turso.mjs", "--json", "--allow-secret-repair"], {
    ...process.env,
    ...env,
  });
  // مخرج المجسّ الموحّد يحمل verdict دائمًا؛ غيابه = عطل في الأداة نفسها.
  const verdict = parsed?.verdict === "PASS" ? "PASS" : parsed?.verdict === "BLOCKED" ? "BLOCKED" : "UNKNOWN";
  return { verdict, exitStatus: status };
}

function smokeVerdict(base) {
  const { parsed, status } = runJson(
    "node",
    ["scripts/smoke-production.mjs", "--json", "--base", base],
    process.env
  );
  const verdict =
    parsed?.verdict === "PASS" || parsed?.verdict === "DEGRADED" || parsed?.verdict === "FAIL"
      ? parsed.verdict
      : status === 2
        ? "UNKNOWN"
        : "FAIL";
  return { verdict, exitStatus: status };
}

if (flag("--self-test")) {
  // إثبات ميكانيكا الالتقاط بلا أسرار: قاعدة ملف فارغة يجب أن تُلتقَط BLOCKED
  // بأمانة (لا PASS كاذب ولا سقوط) — مسار PASS مغطّى باختبار «تقرير آلي».
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "drill-")), "empty.db");
  const { verdict } = probeVerdict({ TURSO_DATABASE_URL: `file:${file}`, TURSO_AUTH_TOKEN: "" });
  const record = { tool: "rotation-drill", mode: "self-test", probe_verdict: verdict };
  if (flag("--json")) console.log(JSON.stringify(record));
  else console.log(`الالتقاط الذاتي: المجسّ على قاعدة فارغة = ${verdict} (المتوقع BLOCKED)`);
  process.exit(verdict === "BLOCKED" ? 0 : 1);
}

const phase = val("--phase");
if (phase !== "pre" && phase !== "post") {
  console.error("❌ --phase pre|post مطلوب (أو --self-test).");
  process.exit(2);
}
if (!process.env.TURSO_DATABASE_URL) {
  console.error("❌ TURSO_DATABASE_URL غير مُعيَّن — التدريب يعمل على اعتماد حقيقي (pre/post) أو --self-test بلا أسرار.");
  process.exit(2);
}

const probe = probeVerdict({});
const smokeBase = process.env.SMOKE_BASE ?? "";
const smoke = smokeBase ? smokeVerdict(smokeBase) : { verdict: null, exitStatus: 0 };
const ok = probe.verdict === "PASS" && smoke.verdict !== "FAIL";
const record = {
  tool: "rotation-drill",
  phase,
  at: new Date().toISOString(),
  probe_verdict: probe.verdict,
  smoke_verdict: smoke.verdict,
  smoke_skipped: !smokeBase,
  ok,
};

if (flag("--json")) {
  console.log(JSON.stringify(record));
} else {
  console.log(`# تدريب التدوير — الطور ${phase}\n`);
  console.log(`- المجسّ: ${probe.verdict}`);
  console.log(`- الـ smoke: ${smoke.verdict ?? "مُتخطَّى (SMOKE_BASE غير مضبوط)"}`);
  console.log(
    ok
      ? "\n✅ هذا الطور أخضر — الصق السجل (--json) في جدول أدلة التدوير."
      : "\n❌ هذا الطور أحمر — لا تُبطِل الرمز القديم ولا تُعلِن النجاح."
  );
}
process.exit(ok ? 0 : 1);
