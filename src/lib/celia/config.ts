/**
 * إعداد Celia Agent — علم ميزة منفصل وحارس نطاقات (ScopeGuard).
 *
 * لماذا علم منفصل `ENABLE_CELIA_AGENT` وليس `ENABLE_AGENT_FLEET`؟
 * - `celia_agent` يملك نطاقات أوسع (قراءة + كتابة محتملة + أدوات خاصة)
 *   بينما أسطول المتجر الحالي للقراءة فقط.
 * - فصله يسمح بتطبيق `ScopeGuard` دقيق ومعزول، وإيقافه دون المساس بالأسطول.
 * - كل مسار يقرأ العلم من البيئة في كل طلب (لا من ذاكرة العملية) ليكون
 *   متسقًا عبر نسخ Vercel المتعددة — نفس نمط `FLEET_DISABLED_AGENTS`.
 *
 * الاستخدام:
 *   if (!isCeliaAgentEnabled()) return 404 / fallback
 *   const guard = createCeliaScopeGuard(request);
 *   if (!guard.can("orders:write")) return 403
 */

export const CELIA_FLAG = "ENABLE_CELIA_AGENT" as const;

/** هل Celia مفعّل؟ قيمة وحيدة مقبولة هي النص "true" (حساس لحالة الأحرف). */
export function isCeliaAgentEnabled(): boolean {
  return process.env[CELIA_FLAG] === "true";
}

/**
 * هل Celia نشط فعليًا (مفعّل + مُهيأ)؟ حاليًا نفس `isCeliaAgentEnabled`،
 * لكنه نقطة توسعة مستقبلية لفحوص إضافية (مثل وجود مفاتيح النموذج).
 * يُبقي مسارات API تفشل بصمت (404 موحّد) عند عدم الجاهزية.
 */
export function isCeliaAgentActive(): boolean {
  return isCeliaAgentEnabled();
}

/**
 * قائمة النطاقات المسموحة لـ Celia من البيئة.
 * - `CELIA_ALLOWED_SCOPES` مفصولة بفواصل، مثل: "products:read,orders:read,orders:write,faq:read"
 * - غيابها أو فراغها = لا نطاق (fail-closed) — Celia لا يستطيع تنفيذ أي أداة
 * - القيمة `*` تعني كل النطاقات (للتجارب المحلية فقط، لا تُستخدم في الإنتاج)
 */
export const CELIA_ALLOWED_SCOPES_ENV = "CELIA_ALLOWED_SCOPES" as const;

export const CELIA_KNOWN_SCOPES = [
  "products:read",
  "products:write",
  "orders:read",
  "orders:write",
  "faq:read",
  "faq:write",
  "chat:read",
  "admin:read",
  "mcp:read",
  "mcp:write",
] as const;

export type CeliaScope = (typeof CELIA_KNOWN_SCOPES)[number] | (string & {});

export function celiaAllowedScopes(): Set<string> {
  const raw = process.env[CELIA_ALLOWED_SCOPES_ENV]?.trim() ?? "";
  if (!raw) return new Set();
  if (raw === "*") return new Set(CELIA_KNOWN_SCOPES);
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

/** هل النطاق مطلوب ضمن المسموح؟ يدعم `*` و `prefix:*` (مثل `orders:*`). */
export function isScopeAllowed(scope: string, allowed: Set<string>): boolean {
  if (allowed.has("*")) return true;
  if (allowed.has(scope)) return true;
  const prefix = scope.split(":")[0] + ":*";
  if (allowed.has(prefix)) return true;
  return false;
}
