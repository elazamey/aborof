#!/usr/bin/env node
/**
 * تدقيق دورة حياة رمز Turso — **مراقبة فقط (observability)**.
 *
 * يفكّ مطالبة `exp` من الرمز المضبوط في `TURSO_AUTH_TOKEN` ويحكم على ما تبقّى من
 * عمره مقابل بوابة تحذير (افتراضي 14 يومًا). لا يسكّ رمزًا، ولا يدوّره، ولا يعدّل
 * سرًّا، ولا يلمس القاعدة — القرار والتدوير بيد المشغّل عبر
 * `bash scripts/mint-turso-token.sh`.
 *
 * لماذا هذا الملف موجود: سياسة المستودع صارت `90d` لا `never` (انظر
 * `DEFAULT_EXPIRATION` في `scripts/lib/turso-api.mjs`)، والعمر المحدود يُلزم
 * بالتدوير؛ وأسرار Actions لا تُقرأ إلا وقت التشغيل داخل runner، فلا سبيل لمعرفة
 * الموعد إلا بفكّ الرمز **داخل** الـ runner. وهذا بالضبط ما يفعله هنا.
 *
 * حدود الأمانة: هذا تدقيق في **بيانات الرمز** (exp) لا فحص صلاحية — توقيع JWT
 * لا يُتحقَّق منه (لا مفتاح لدينا)، وإثبات الاتصال يبقى `npm run verify:turso`.
 *
 * الاستخدام:
 *   node scripts/audit-token-lifecycle.mjs                       # التقرير (markdown)
 *   TURSO_AUTH_TOKEN='eyJ…' node scripts/audit-token-lifecycle.mjs --json
 *   node scripts/audit-token-lifecycle.mjs --threshold-days 30
 *   node scripts/audit-token-lifecycle.mjs --now 2026-12-01T00:00:00Z   # تثبيت الزمن
 *   node scripts/audit-token-lifecycle.mjs --token-env TURSO_ROTATION_TOKEN
 *
 * الأحكام (status / action / كود الخروج):
 *   PASS          exp بعيد (> البوابة)                 NONE                    0
 *   WARNING       exp داخل البوابة (≤ 14 يومًا)         OPEN_OR_UPDATE_ISSUE   10
 *   FAIL          منتهي، أو قيمة لا تُفكّ، أو رابط لُصق  OPEN_OR_UPDATE_ISSUE    1
 *                 في حقل الرمز (عطل الإنتاج المرصود)
 *   NO_EXPIRY     رمز صالح بلا exp (`never`)            NONE — يُعرض بوضوح      0
 *   NOT_CONFIGURED لا قيمة في المتغير                   NONE (تخطٍّ)            2
 *   (خطأ استخدام: وسيط غير صالح — رسالة إلى stderr وبلا تقرير)                64
 *
 * لا تُطبع قيمة الرمز ولا أي مطالبة فيه عدا `exp` (ولا جزء منها): المعروض النوع
 * والطول والتاريخ والحكم. وأي رسالة خطأ تمرّ عبر `redact`.
 */
import process from "node:process";
import { redact } from "./lib/migration-checksums.mjs";
import { describeTokenShape } from "./lib/turso-api.mjs";

/** بوابة التحذير الافتراضية: آخر 14 يومًا من عمر الرمز. */
export const DEFAULT_THRESHOLD_DAYS = 14;

/** الأحكام الخمسة — أسماء ثابتة يقرؤها الغلاف والاختبارات (لا نصوص عربية متغيّرة). */
export const LIFECYCLE_STATUSES = ["PASS", "WARNING", "FAIL", "NO_EXPIRY", "NOT_CONFIGURED"];

const DAY_MS = 86_400_000;

const argv = process.argv.slice(2);
function flag(name) {
  return argv.includes(name);
}
function argValue(name, fallback = "") {
  const at = argv.indexOf(name);
  return at >= 0 && at + 1 < argv.length ? argv[at + 1] : fallback;
}

/* ------------------------------------------------------------------ */
/* فكّ الرمز: النوع والشكل و exp — بلا أي مطالبة أخرى                    */
/* ------------------------------------------------------------------ */

/**
 * ما يخرجه فكّ الرمز: وصف **قابل للطباعة** وحده. لا توقيع ولا `sub` ولا `id` ولا
 * نص حمولة — والأنواع موثّقة بـ JSDoc لأن الاختبارات (TypeScript) تستورد هذه الدوال.
 *
 * @typedef {object} DecodedTokenExpiry
 * @property {string} kind نوع القيمة كما يصفه `describeTokenShape` (JWT / رابط لا رمز / …)
 * @property {string} shape وصف الشكل والطول — آمن للنشر
 * @property {number} length طول القيمة المضبوطة
 * @property {number | null} exp انتهاء الرمز بالثواني، أو `null` إن لم توجد مطالبة صالحة
 * @property {string} parseNote سبب تعذّر قراءة `exp` (فارغة إن قُرئت)
 *
 * @param {string} token
 * @returns {DecodedTokenExpiry}
 */
export function decodeTokenExpiry(token) {
  const raw = String(token ?? "");
  const shape = describeTokenShape(raw);
  const result = { kind: shape.kind, shape: shape.detail, length: raw.length, exp: null, parseNote: "" };
  if (!raw.trim()) return result;

  const parts = raw.split(".");
  if (parts.length < 2) {
    result.parseNote = "ليست JWT (أقل من مقطعين) — لا مطالبة exp قابلة للقراءة";
    return result;
  }
  let claims;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    claims = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  } catch {
    result.parseNote = "حمولة الرمز غير قابلة للفك (base64/JSON) — لا يُحكم على الانتهاء";
    return result;
  }
  if (!claims || typeof claims !== "object") {
    result.parseNote = "حمولة الرمز ليست كائنًا — لا مطالبة exp";
    return result;
  }
  // `exp` مطالبة قياسية بالثواني. `0`/`null`/غيابها = بلا انتهاء (رمز `never`).
  const exp = claims.exp;
  if (typeof exp === "number" && Number.isFinite(exp) && exp > 0) {
    result.exp = Math.floor(exp);
  } else if (exp !== undefined && exp !== null && exp !== 0) {
    result.parseNote = "مطالبة exp موجودة وليست رقمًا — تُعامل كرمز غير صالح";
    result.kind = "غير معروف";
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* الحكم: نقّي وقابل للاختبار عند الحدود                               */
/* ------------------------------------------------------------------ */

/**
 * يصنّف دورة الحياة. `nowMs` قابل للتثبيت (اختبار الحدود عند 14 يومًا بالضبط بلا
 * اعتماد على ساعة الجهاز)، والمقارنة بالميلي ثانية لا بالأيام المقرّبة — فاليوم
 * الرابع عشر نفسه داخل البوابة (`≤14d ⇒ WARNING`) كما في العقد المطلوب.
 *
 * @typedef {object} LifecycleVerdict
 * @property {string} status أحد `LIFECYCLE_STATUSES`
 * @property {string} action `NONE` أو `OPEN_OR_UPDATE_ISSUE`
 * @property {number} thresholdDays البوابة المطبَّقة
 * @property {string} expiresAt تاريخ الانتهاء `YYYY-MM-DD` (فارغ لرمز أبدي أو غير مقروء)
 * @property {string} expiresAtIso اللحظة الكاملة بصيغة ISO
 * @property {number | null} remainingDays الأيام المتبقية (بالأرضية)، أو `null`
 * @property {number | null} remainingMs المتبقي بالميلي ثانية — أساس المقارنة الدقيقة
 * @property {string} kind
 * @property {string} shape
 * @property {number} length
 * @property {string} note شرح الحكم بالعربية (بلا قيمة سرية)
 *
 * @param {{ decoded?: DecodedTokenExpiry | null, nowMs?: number, thresholdDays?: number }} [options]
 * @returns {LifecycleVerdict}
 */
export function classifyLifecycle({ decoded, nowMs = Date.now(), thresholdDays = DEFAULT_THRESHOLD_DAYS } = {}) {
  const thresholdMs = Number(thresholdDays) * DAY_MS;
  const base = {
    status: "NOT_CONFIGURED",
    action: "NONE",
    thresholdDays: Number(thresholdDays),
    expiresAt: "",
    expiresAtIso: "",
    remainingDays: null,
    remainingMs: null,
    kind: decoded?.kind ?? "فارغ",
    shape: decoded?.shape ?? "لا قيمة",
    length: decoded?.length ?? 0,
    note: "",
  };

  if (!decoded || !decoded.length) {
    return { ...base, note: "لا قيمة في متغير الرمز — لا شيء للتدوير بعد." };
  }

  // رابط اتصال لُصق في حقل الرمز: عطل الإنتاج المرصود، ويُقال باسمه لا كـ«رمز تالف».
  if (decoded.kind === "رابط لا رمز") {
    return {
      ...base,
      status: "FAIL",
      action: "OPEN_OR_UPDATE_ISSUE",
      note: "القيمة رابط اتصال لا رمز (MISPLACED_VALUE) — انقل الرابط إلى TURSO_DATABASE_URL واسكّ رمزًا بـ scripts/mint-turso-token.sh.",
    };
  }
  if (decoded.kind !== "JWT" && decoded.kind !== "JWT محتمل") {
    return {
      ...base,
      status: "FAIL",
      action: "OPEN_OR_UPDATE_ISSUE",
      note: decoded.parseNote || "القيمة ليست رمز JWT — لا يمكن الحكم على انتهائها.",
    };
  }
  if (decoded.parseNote) {
    return { ...base, status: "FAIL", action: "OPEN_OR_UPDATE_ISSUE", note: decoded.parseNote };
  }
  if (decoded.exp === null) {
    return {
      ...base,
      status: "NO_EXPIRY",
      action: "NONE",
      note: "رمز بلا انتهاء (exp غائبة) — ليس خطأً، لكنه خلاف سياسة 90d؛ التدوير اليدوي يبقى موصى به.",
    };
  }

  const expMs = decoded.exp * 1000;
  const remainingMs = expMs - nowMs;
  const expiresAtIso = new Date(expMs).toISOString();
  const filled = {
    ...base,
    expiresAt: expiresAtIso.slice(0, 10),
    expiresAtIso,
    remainingMs,
    remainingDays: Math.floor(remainingMs / DAY_MS),
  };

  if (remainingMs <= 0) {
    return {
      ...filled,
      status: "FAIL",
      action: "OPEN_OR_UPDATE_ISSUE",
      note: `الرمز منتهي منذ ${Math.abs(filled.remainingDays)} يومًا — القاعدة ترفضه؛ اسكّ رمزًا جديدًا فورًا.`,
    };
  }
  if (remainingMs <= thresholdMs) {
    return {
      ...filled,
      status: "WARNING",
      action: "OPEN_OR_UPDATE_ISSUE",
      note: `داخل بوابة التدوير: بقي ${filled.remainingDays} يومًا (≤ ${filled.thresholdDays}).`,
    };
  }
  return { ...filled, status: "PASS", action: "NONE", note: `خارج بوابة التدوير: بقي ${filled.remainingDays} يومًا.` };
}

/* ------------------------------------------------------------------ */
/* التقرير                                                             */
/* ------------------------------------------------------------------ */

/**
 * كتلة الأدلة بالحرف المطلوب — مفاتيح إنجليزية ثابتة يسهل قراءتها آليًا وبشريًا.
 *
 * @param {LifecycleVerdict} verdict
 * @param {{ tokenEnv?: string }} [options]
 * @returns {string}
 */
export function renderEvidence(verdict, { tokenEnv = "TURSO_AUTH_TOKEN" } = {}) {
  return [
    "Turso token lifecycle audit",
    `Status: ${verdict.status}`,
    `Expires: ${verdict.expiresAt || "never"}`,
    `Remaining: ${verdict.remainingDays === null ? "n/a" : `${verdict.remainingDays} days`}`,
    `Rotation threshold: ${verdict.thresholdDays} days`,
    `Action: ${verdict.action}`,
    `Source: ${tokenEnv} (runner env — never argv, never printed)`,
  ].join("\n");
}

const STATUS_AR = {
  PASS: "أخضر — لا إجراء",
  WARNING: "داخل نافذة التدوير — Issue واحد وتحذير دائم",
  FAIL: "أحمر — تدوير فوري",
  NO_EXPIRY: "رمز أبدي — ليس خطأً لكنه خلاف السياسة",
  NOT_CONFIGURED: "لا قيمة مضبوطة — تخطٍّ",
};

/**
 * تقرير markdown: يُطبع في السجل ويُلصق كما هو في $GITHUB_STEP_SUMMARY.
 *
 * @param {LifecycleVerdict} verdict
 * @param {{ tokenEnv?: string, scope?: string }} [options]
 * @returns {string}
 */
export function renderMarkdown(verdict, { tokenEnv = "TURSO_AUTH_TOKEN", scope = "" } = {}) {
  const mark =
    verdict.status === "PASS" || verdict.status === "NO_EXPIRY"
      ? "✅"
      : verdict.status === "WARNING"
        ? "⚠️"
        : verdict.status === "NOT_CONFIGURED"
          ? "ℹ️"
          : "❌";
  return [
    `### 🗓️ تدقيق دورة حياة رمز Turso ${scope ? `— ${scope}` : ""}`,
    "",
    "```text",
    renderEvidence(verdict, { tokenEnv }),
    "```",
    "",
    "| الحقل | القيمة |",
    "|---|---|",
    `| الحكم | ${mark} **${verdict.status}** — ${STATUS_AR[verdict.status] ?? ""} |`,
    `| نوع القيمة المضبوطة | ${verdict.kind} (${verdict.shape}) |`,
    `| انتهاء الرمز (\`exp\`) | ${verdict.expiresAtIso || "بلا مطالبة exp"} |`,
    `| الأيام المتبقية | ${verdict.remainingDays === null ? "—" : verdict.remainingDays} |`,
    `| بوابة التحذير | ${verdict.thresholdDays} يومًا |`,
    `| الإجراء | ${verdict.action} |`,
    `| مصدر القيمة | ${tokenEnv} من بيئة الـ runner (لا argv، ولا طباعة) |`,
    "",
    verdict.note ? `**ملاحظة:** ${verdict.note}` : "",
    "",
    "التدوير (يد المشغّل لا الـ workflow): `bash scripts/mint-turso-token.sh` — يسكّ رمزًا",
    "جديدًا بعمر 90 يومًا، يعيد تطبيق الهجرات إن لزم، ويسلّم الزوج إلى GitHub وVercel.",
    "",
    "> هذا تدقيق في بيانات الرمز (`exp`) لا فحص صلاحية: التوقيع لا يُتحقَّق منه هنا،",
    "> وإثبات الاتصال يبقى `npm run verify:turso` ومجسّ `turso-evidence.yml`.",
  ]
    .filter((line, index, all) => !(line === "" && all[index - 1] === ""))
    .join("\n");
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

async function main() {
  if (flag("-h") || flag("--help")) {
    const lines = [];
    let started = false;
    for (const line of (await import("node:fs")).readFileSync(new URL(import.meta.url), "utf8").split("\n")) {
      if (!started) {
        if (line.startsWith("/**")) started = true;
        continue;
      }
      if (line.startsWith(" */")) break;
      lines.push(line.replace(/^ ?\* ?/, ""));
    }
    console.log(lines.join("\n"));
    return 0;
  }

  const tokenEnv = String(argValue("--token-env") || process.env.TURSO_TOKEN_ENV || "TURSO_AUTH_TOKEN").trim();
  const token = String(process.env[tokenEnv] ?? "");
  const thresholdRaw = argValue("--threshold-days") || process.env.TURSO_ROTATION_THRESHOLD_DAYS || "";
  const thresholdDays = thresholdRaw === "" ? DEFAULT_THRESHOLD_DAYS : Number(thresholdRaw);
  const asJson = flag("--json");

  if (!Number.isFinite(thresholdDays) || thresholdDays < 0 || thresholdDays > 3650) {
    console.error(`❌ --threshold-days غير مقبول (${thresholdRaw}) — العدد المتوقع أيام بين 0 و3650.`);
    // ‏64 لا 2: خطأ استخدام (وسيط فاسد) غير «لا قيمة مضبوطة» — الغلاف يفشل بصوت عالٍ.
    return 64;
  }

  let nowMs = Date.now();
  const nowArg = argValue("--now");
  if (nowArg) {
    const parsed = Date.parse(nowArg);
    if (Number.isNaN(parsed)) {
      console.error(`❌ --now ليس تاريخًا صالحًا (${redact(nowArg)}) — يُستخدم لتثبيت الزمن في الاختبارات.`);
      return 64;
    }
    nowMs = parsed;
  }

  const decoded = decodeTokenExpiry(token);
  const verdict = classifyLifecycle({ decoded, nowMs, thresholdDays });
  verdict.tokenEnv = tokenEnv;
  verdict.checkedAt = new Date(nowMs).toISOString();

  // أي نص قد يحمل القيمة يمرّ عبر الحجب — احتياطًا، مع أن التقرير لا يبني شيئًا منها.
  const secrets = [token].filter((value) => value.length >= 8);
  if (asJson) {
    console.log(redact(JSON.stringify(verdict, null, 2), secrets));
  } else {
    console.log(redact(renderMarkdown(verdict, { tokenEnv }), secrets));
  }

  switch (verdict.status) {
    case "PASS":
    case "NO_EXPIRY":
      return 0;
    case "NOT_CONFIGURED":
      return 2;
    case "WARNING":
      return 10;
    default:
      return 1;
  }
}

// بلا `await` أعلى: هذا الملف تُستورد دواله من الاختبارات (انظر turso-api.mjs).
if (Boolean(process.argv[1]) && process.argv[1].endsWith("audit-token-lifecycle.mjs")) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      const secrets = [process.env.TURSO_AUTH_TOKEN].filter(Boolean);
      console.error(`❌ توقف التدقيق: ${redact(String(error?.message ?? error), secrets)}`);
      process.exit(1);
    }
  );
}
