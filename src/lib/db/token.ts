/**
 * حلّ رمز Turso لتشغيل التطبيق (الدور `prod` في عقد الفصل).
 * نظير `resolveTursoToken(env, "prod")` في `scripts/lib/db-url.mjs` — مكرّر هنا
 * عمدًا لأن حزمة التشغيل (Next.js) لا تستورد من `scripts/`. القاعدتان متطابقتان
 * لفظًا، وكلتاهما مُغطّاة باختبار يثبّت التطابق السلوكي.
 *
 * الترتيب: `TURSO_AUTH_TOKEN_PROD` ثم السقوط المُعلَن على `TURSO_AUTH_TOKEN`
 * المشترك. انظر `docs/ops/secret-rotation.md`.
 */
export interface ResolvedAppToken {
  token: string | null;
  /** اسم المتغير الذي أُخذت منه القيمة، أو null عند الغياب الكامل. */
  source: "TURSO_AUTH_TOKEN_PROD" | "TURSO_AUTH_TOKEN" | null;
  /** true = يُستخدم الرمز المشترك القديم — يستحق تحذير ترحيل في السجل. */
  fallback: boolean;
}

export function resolveAppToken(env: Record<string, string | undefined>): ResolvedAppToken {
  const scoped = env.TURSO_AUTH_TOKEN_PROD;
  if (typeof scoped === "string" && scoped.length > 0) {
    return { token: scoped, source: "TURSO_AUTH_TOKEN_PROD", fallback: false };
  }
  const legacy = env.TURSO_AUTH_TOKEN;
  if (typeof legacy === "string" && legacy.length > 0) {
    return { token: legacy, source: "TURSO_AUTH_TOKEN", fallback: true };
  }
  return { token: null, source: null, fallback: false };
}
