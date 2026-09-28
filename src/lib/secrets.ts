/**
 * إدارة الأسرار والمفاتيح — فصل الأغراض.
 *
 * عقد السياسة:
 *  - `ADMIN_SESSION_SECRET`  → لتوقيع جلسات الإدارة فقط (HMAC). لا يُستخدم لأي غرض آخر.
 *  - `DIAGNOSTICS_KEY`       → مفتاح مستقل لنقطة التشخيص `/api/admin/diagnostics`.
 *
 * التشخيص معطل في الإنتاج افتراضيًا، ولا يُفعَّل إلا بتعيين `DIAGNOSTICS_ENABLED=true`
 * مع وجود `DIAGNOSTICS_KEY` قوي — ولا يقبل أبدًا استخدام سر الجلسات كمفتاح تشخيص.
 */

const MIN_SECRET_LENGTH = 32;
const MIN_DIAGNOSTICS_KEY_LENGTH = 24;

export interface SecretWarning {
  code:
    | "SESSION_SECRET_MISSING"
    | "SESSION_SECRET_WEAK"
    | "ADMIN_PASSWORD_MISSING"
    | "ADMIN_PASSWORD_WEAK"
    | "DIAGNOSTICS_KEY_MISSING"
    | "DIAGNOSTICS_ENABLED_WITHOUT_KEY"
    | "DIAGNOSTICS_SHARED_WITH_SESSION"
    | "TURSO_URL_MISSING"
    | "TURSO_URL_DASHBOARD"
    | "TURSO_URL_INVALID"
    | "TURSO_TOKEN_MISSING"
    | "TURSO_TOKEN_IS_URL"
    | "TURSO_TOKEN_INVALID";
  message: string;
}

function timingSafeEqualString(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return require("node:crypto").timingSafeEqual(ab, bb);
}

export function isDiagnosticsEnabled(): boolean {
  if (process.env.NODE_ENV === "production" && process.env.DIAGNOSTICS_ENABLED !== "true") {
    return false;
 }
  if (process.env.DIAGNOSTICS_ENABLED === "false") return false;
  return Boolean(process.env.DIAGNOSTICS_ENABLED === "true" && process.env.DIAGNOSTICS_KEY);
}

/**
 * يتحقق من مفتاح التشخيص بطريقة آمنة زمنيًا، ويرفض أي مفتاح يساوي سر الجلسات
 * حتى لا يُعاد استخدام السر نفسه لغرضين.
 */
export function diagnosticsKeyMatches(provided: string | null | undefined): boolean {
  const configured = process.env.DIAGNOSTICS_KEY;
  if (!isDiagnosticsEnabled() || !configured || !provided) return false;
  if (configured.length < MIN_DIAGNOSTICS_KEY_LENGTH) return false;
  const sessionSecret = process.env.ADMIN_SESSION_SECRET;
  if (sessionSecret && timingSafeEqualString(configured, sessionSecret)) return false;
  if (provided === sessionSecret) return false;
  return timingSafeEqualString(provided, configured);
}

/**
 * سياسة كلمة المرور الموحدة: 12 حرفًا على الأقل، وتُطبَّق عند تجهيز/تغيير
 * كلمة مرور الإدارة. الحد الأدنى ثابت وقابل للاختبار.
 */
export const PASSWORD_POLICY = {
  minLength: 12,
  maxLength: 200,
} as const;

export function isPasswordStrong(password: string | undefined | null): boolean {
  return Boolean(
    password &&
      password.length >= PASSWORD_POLICY.minLength &&
      password.length <= PASSWORD_POLICY.maxLength
  );
}

export function sessionSecretConfigured(): boolean {
  const v = process.env.ADMIN_SESSION_SECRET;
  return Boolean(v && v.length >= MIN_SECRET_LENGTH);
}

function isDashboardUrlLoose(url: string): boolean {
  const lower = url.toLowerCase();
  return lower.includes("app.turso.tech") || lower.includes("www.turso.tech");
}

function isLocalUrlLoose(url: string): boolean {
  const t = url.trim();
  return t.startsWith("file:") || t === ":memory:" || t.startsWith(":memory:") || t.startsWith("file::memory:");
}

function looksLikeJwt(token: string): boolean {
  return /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(token.trim());
}

/**
 * فحص تهيئة الأسرار دون كشف أي قيمة — يُستخدم في بداية التشغيل وفي التشخيص.
 * التحذيرات تُسجَّل محليًا فقط ولا تتضمن القيم.
 * يتضمن الآن فحص Turso حسب توثيق https://docs.turso.tech/sdk/authentication
 */
export function auditSecretConfiguration(): SecretWarning[] {
  const warnings: SecretWarning[] = [];
  const sessionSecret = process.env.ADMIN_SESSION_SECRET;
  const adminPassword = process.env.ADMIN_PASSWORD;
  const diagnosticsKey = process.env.DIAGNOSTICS_KEY;
  const diagnosticsEnabled = process.env.DIAGNOSTICS_ENABLED === "true";
  const tursoUrl = process.env.TURSO_DATABASE_URL;
  const tursoToken = process.env.TURSO_AUTH_TOKEN;

  if (!sessionSecret) warnings.push({ code: "SESSION_SECRET_MISSING", message: "ADMIN_SESSION_SECRET غير معين." });
  else if (sessionSecret.length < MIN_SECRET_LENGTH)
    warnings.push({ code: "SESSION_SECRET_WEAK", message: "ADMIN_SESSION_SECRET يجب ألا يقل عن 32 حرفًا." });

  if (!adminPassword) warnings.push({ code: "ADMIN_PASSWORD_MISSING", message: "ADMIN_PASSWORD غير معين." });
  else if (!isPasswordStrong(adminPassword))
    warnings.push({
      code: "ADMIN_PASSWORD_WEAK",
      message: `ADMIN_PASSWORD يجب ألا يقل عن ${PASSWORD_POLICY.minLength} حرفًا وفق سياسة كلمة المرور.`,
    });

  if (diagnosticsEnabled) {
    if (!diagnosticsKey)
      warnings.push({ code: "DIAGNOSTICS_ENABLED_WITHOUT_KEY", message: "DIAGNOSTICS_ENABLED=true بدون DIAGNOSTICS_KEY — التشخيص متوقف." });
    else if (sessionSecret && diagnosticsKey === sessionSecret)
      warnings.push({ code: "DIAGNOSTICS_SHARED_WITH_SESSION", message: "DIAGNOSTICS_KEY يساوي ADMIN_SESSION_SECRET — افصل بين المفتاحين." });
  }

  // فحص Turso — لا يمنع التشغيل لكنه يوضح سبب عمل الموقع من البذرة المحلية
  if (!tursoUrl) {
    warnings.push({
      code: "TURSO_URL_MISSING",
      message: "TURSO_DATABASE_URL غير معين — الموقع يعمل من البذرة المحلية ويفشل إنشاء الطلبات بـ 503.",
    });
  } else if (isDashboardUrlLoose(tursoUrl)) {
    warnings.push({
      code: "TURSO_URL_DASHBOARD",
      message: "TURSO_DATABASE_URL يحمل رابط لوحة تحكم (app.turso.tech) وليس رابط اتصال libsql://[DB]-[ORG].turso.io — انسخه من زر Connect.",
    });
  } else if (!isLocalUrlLoose(tursoUrl) && !/^(libsql|turso|https|wss|ws):\/\//i.test(tursoUrl)) {
    warnings.push({
      code: "TURSO_URL_INVALID",
      message: "TURSO_DATABASE_URL يجب أن يبدأ بـ libsql:// أو turso:// أو https:// حسب https://docs.turso.tech/sdk/authentication",
    });
  }

  if (tursoUrl && !isLocalUrlLoose(tursoUrl)) {
    if (!tursoToken) {
      warnings.push({ code: "TURSO_TOKEN_MISSING", message: "TURSO_AUTH_TOKEN غير معين — مطلوب مع أي رابط غير محلي." });
    } else if (tursoToken.includes("://")) {
      warnings.push({
        code: "TURSO_TOKEN_IS_URL",
        message: "TURSO_AUTH_TOKEN يحمل رابط اتصال (libsql://) بدل رمز JWT — انقل الرابط إلى TURSO_DATABASE_URL والرمز eyJ... إلى TURSO_AUTH_TOKEN.",
      });
    } else if (!looksLikeJwt(tursoToken)) {
      warnings.push({
        code: "TURSO_TOKEN_INVALID",
        message: "TURSO_AUTH_TOKEN لا يبدو JWT (يجب أن يبدأ بـ eyJ). أنشئ رمزًا عبر turso db tokens create <db> --expiration never",
      });
    }
  }

  return warnings;
}
