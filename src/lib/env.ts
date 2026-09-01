/**
 * Environment Contract — فحص المتغيرات الحرجة عند الإقلاع.
 * في الإنتاج: نقص متغير حرج = STARTUP FAIL (وليس "admin مكسور بغموض").
 * في التطوير: تحذير فقط حتى لا نعطّل التجربة المحلية بدون بيانات.
 */
export function validateEnv(): string[] {
  const problems: string[] = [];
  const url = process.env.TURSO_DATABASE_URL;

  if (!url) {
    problems.push("TURSO_DATABASE_URL is required in production");
  } else if (url.startsWith("libsql://") && !process.env.TURSO_AUTH_TOKEN) {
    problems.push("TURSO_AUTH_TOKEN is required when TURSO_DATABASE_URL is a remote Turso database");
  }

  if (!process.env.ADMIN_SESSION_SECRET || process.env.ADMIN_SESSION_SECRET.length < 32) {
    problems.push("ADMIN_SESSION_SECRET must be set and at least 32 characters (required for the admin panel)");
  }

  if (process.env.NODE_ENV === "production" && problems.length > 0) {
    throw new Error("Environment contract violated: " + problems.join("; "));
  }
  return problems;
}
