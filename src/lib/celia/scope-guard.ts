/**
 * حارس النطاقات (ScopeGuard) لـ Celia Agent — تطبيق دقيق ومعزول.
 *
 * المبدأ: كل أداة تُستدعى عبر Celia يجب أن تمرّ عبر هذا الحارس قبل التنفيذ.
 * - fail-closed: بلا `ENABLE_CELIA_AGENT=true` أو بلا نطاق مسموح → رفض.
 * - لا يعتمد على حالة في الذاكرة — يقرأ البيئة في كل استدعاء (يتسق عبر Vercel).
 * - لا يكشف معلومات حساسة في رسائل الرفض (404 موحّد للخارج، 403 داخلي فقط للسجل).
 *
 * مثال:
 *   const guard = createCeliaScopeGuard();
 *   if (!guard.can("orders:write")) throw Errors.forbidden("Scope denied");
 *   // أو مع وسوم إضافية:
 *   guard.assert("products:read");
 */

import {
  celiaAllowedScopes,
  isCeliaAgentEnabled,
  isScopeAllowed,
  type CeliaScope,
} from "./config";
import { Errors } from "@/lib/errors";

export interface CeliaScopeGuard {
  /** هل Celia مفعّل أصلًا؟ */
  enabled: boolean;
  /** النطاقات المسموحة الحالية (لقطة من البيئة). */
  allowed: Set<string>;
  /** هل يملك هذا النطاق؟ */
  can(scope: CeliaScope): boolean;
  /** يرمي `Forbidden` إن لم يملك النطاق (مع سجل آمن بلا تسريب). */
  assert(scope: CeliaScope): void;
  /** يتحقق من قائمة نطاقات دفعة واحدة — يرمي إن فُقد واحد. */
  assertAll(scopes: CeliaScope[]): void;
}

export function createCeliaScopeGuard(): CeliaScopeGuard {
  const enabled = isCeliaAgentEnabled();
  const allowed = celiaAllowedScopes();

  return {
    enabled,
    allowed,
    can(scope: string) {
      if (!enabled) return false;
      if (allowed.size === 0) return false;
      return isScopeAllowed(scope, allowed);
    },
    assert(scope: string) {
      if (!enabled) {
        throw Errors.forbidden("Celia غير مفعّل (ENABLE_CELIA_AGENT).");
      }
      if (allowed.size === 0) {
        throw Errors.forbidden("لا نطاقات مسموحة لـ Celia (CELIA_ALLOWED_SCOPES).");
      }
      if (!isScopeAllowed(scope, allowed)) {
        // لا نكشف قائمة النطاقات في رسالة العميل — تُسجَّل فقط داخليًا إن لزم.
        throw Errors.forbidden(`النطاق غير مسموح: ${scope}`);
      }
    },
    assertAll(scopes: string[]) {
      for (const s of scopes) this.assert(s);
    },
  };
}

/**
 * غلاف لمسارات API: يتحقق من العلم والنطاق ثم ينفّذ المُعالج.
 * يُعيد 404 موحّد إن كان العلم مغلقًا (لا يكشف وجود النقطة)، و403 إن كان
 * النطاق مرفوضًا.
 *
 * @example
 *   export async function POST(req: Request) {
 *     const guard = requireCeliaScope(req, "orders:write");
 *     // ... منطق الكتابة
 *   }
 */
export function requireCeliaScope(
  _request: Request,
  scope: CeliaScope
): CeliaScopeGuard {
  const guard = createCeliaScopeGuard();
  if (!guard.enabled) {
    // 404 موحّد لا يكشف وجود النقطة — نفس نمط `/api/admin/agents`.
    throw Errors.notFound("غير موجود");
  }
  guard.assert(scope);
  return guard;
}
